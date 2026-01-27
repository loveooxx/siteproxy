// Backend main script file for both Cloudflare Workers and node.js env.

import { Hono } from "hono";
import { env } from "hono/adapter";
import {
  PREFIX,
  FLAG_RAW,
  NO_REQUEST_BODY_METHODS,
  HEADER_ACCEPT_ENCODING,
  HEADER_CACHE_CONTROL,
  HEADER_CF_CONNECTING_IP,
  HEADER_CLEAR_SITE_DATA,
  HEADER_CONTENT_DISPOSITION,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_LENGTH,
  HEADER_CONTENT_SECURITY_POLICY,
  HEADER_CONTENT_SECURITY_POLICY_REPORT_ONLY,
  HEADER_CONTENT_TYPE,
  HEADER_COOKIE,
  HEADER_HOST,
  HEADER_LOCATION,
  HEADER_REFERER,
  HEADER_ORIGIN,
  HEADER_PREFIX_SITEPROXY,
  HEADER_SEC_FETCH_DEST,
  HEADER_SET_COOKIE,
  HEADER_SITEPROXY_NEWREFERER,
  HEADER_SITEPROXY_DEST,
  HEADER_X_FORWARDED_FOR,
  HEADER_X_FRAME_OPTIONS,
  HEADER_TRANSFER_ENCODING,
  HTML_MODIFIABLE_FETCH_DEST_,
  JS_MODIFIABLE_FETCH_DEST,
  CONTENT_DISPOSITION_ATTACHMENT,
  CACHE_CONTROL_NO_CACHE,
  CLEAR_SITE_DATA_ALL,
  VAR_URL,
  Marks,
  markProto,
  restoreUrl,
  fixInputUrl,
  escapeRegExp,
  shouldLog,
  isBaseOrSubHost,
} from "./lib";

const IS_NODE = typeof globalThis.addEventListener === "undefined";

const Port = parseInt(process.env.PORT || "") || 5006;

if (!process.env.PROXY_URL) {
  process.env.PROXY_URL = `http://localhost${Port !== 80 ? `:${Port}` : ""}/`;
  console.warn(`PROXY_URL not set, use localhost with ${Port} port as fallback`);
  console.warn(`In production env, you should set it to to your server origin, optionally with path prefix`);
}
const ProxyUrl = new URL(process.env.PROXY_URL);
ProxyUrl.search = "";
ProxyUrl.hash = "";
ProxyUrl.username = "";
ProxyUrl.password = "";
if (!ProxyUrl.pathname.endsWith("/")) {
  ProxyUrl.pathname += "/";
}
console.log(`Effective PROXY_URL: ${ProxyUrl.href}`);

const UrlKeywordBlacklist = ["https://web.telegram.org/k/sw-"] as const;

const BodyModHostBlacklist = ["telegram.org", "nga.178.com"] as const;

const MIME_HTML = "text/html";
const MIME_JS = "application/javascript";
const MIME_JS2 = "text/javascript";

type CompressFunc = (data: any, encoding: string) => Promise<any>;

// environment variables / bindings
type Bindings = {
  /**
   * Default (undefined), "" or "0": display top bar in proxified page;
   * "1": hide top bar.
   */
  HIDE_TOP?: string;
  /**
   * Default (undefined), "" or "0": do not log;
   * "1" or "*" : log every request;
   * other vlaue: comma-separated keywords, log if target url contains any keyword in list.
   */
  DEBUG?: string;
  /**
   * Optional. Inject custom JavaScript file url to html pages. E.g.
   * "https://example.com/{{domain}}.js" .
   * Variable placeholders:
   * - {{domain}} : current website domain. e.g. "google.com" .
   * - {{ts}} : now unix timestamp in miliseconds.
   */
  SCRIPT?: string;
  /**
   * Optional. Comma-separated domain names.
   * If not empty, only inject custom JavaScript if site domain equals with or ends with any domain of list.
   */
  SCRIPT_DOMAINS?: string;
  ASSETS: {
    fetch: typeof fetch;
  };
};

// Variables: data shared between middleware
type Variables = {};

// Combine them into a single Env type
type Env = {
  Bindings: Bindings;
  Variables: Variables;
};

interface ResponseModOptions {
  targetUrl: URL;
  rawReqHeaders: Headers;
  reqHeaders: Headers;
  resHeaders: Headers;
  res: Response;
  HIDE_TOP?: string;
  DEBUG?: string;
  SCRIPT?: string;
  SCRIPT_DOMAINS?: string;
}

let compressFunc: CompressFunc | undefined;

if (IS_NODE) {
  const zlib = await import("node:zlib");
  compressFunc = async (data, encoding) => {
    // 1. 边界检查：如果没有数据，直接返回
    if (!data || data.length === 0) {
      return Buffer.alloc(0);
    }

    // 确保数据是 Buffer 类型 (zlib 需要)
    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data);
    }

    const compressedData = await new Promise((resolve, reject) => {
      const cb = (err: unknown, result: unknown) => (err ? reject(err) : resolve(result));
      switch (encoding) {
        case "gzip":
          // 对应 Content-Encoding: gzip
          return zlib.gzip(data, cb);
        case "br":
          // 对应 Content-Encoding: br (Brotli)
          // Brotli 压缩率更高，但速度较慢，通常用于静态资源
          return zlib.brotliCompress(data, cb);
        case "deflate":
          // 对应 Content-Encoding: deflate
          return zlib.deflate(data, cb);
        default:
          return reject(`Unsupported compression encoding: ${encoding}`);
      }
    });
    return compressedData;
  };
}

function removeSiteproxyHeaders(headers: Headers) {
  const deleteKeys: string[] = [];
  headers.forEach((value, key) => {
    key = key.toLowerCase();
    if (key.startsWith(HEADER_PREFIX_SITEPROXY) || key === HEADER_X_FORWARDED_FOR || key === HEADER_CF_CONNECTING_IP) {
      deleteKeys.push(key);
    }
  });
  deleteKeys.forEach((key) => {
    headers.delete(key);
  });
}

function rewriteSearchQuery(proxyUrl: URL, search: string) {
  // Replaces absolute proxy URLs in query params back to standard URLs
  // e.g. ?url=http://proxy/prefix/https/target -> ?url=https://target
  return search.replace(new RegExp(escapeRegExp(proxyUrl.href) + "(https?)(?:://|/)([^/]+)"), "$1://$2");
}

/**
 * 解析路径，一次性提取协议、主机和真实路径
 * @param pathStr 去除 path prefix 前缀后的 pathname. Supported forms:
 * "https/google.com/search", "https://google.com/search".
 * @param proxyUrl 代理本身的 URL 对象 (用于 CustomPathRewrite 修复逻辑)
 * @returns [protocol, host, realPath]
 */
function pathname2Target(
  pathStr: string,
  proxyUrl: URL
): [targetProtocol: string, targetHost: string, targetPathname: string] {
  // group 1: optional protocol, http | https .
  // group 2: host.
  // group 3: pathname.
  const regex = /^(?:(https?)(?::\/\/|\/))([-a-z0-9A-Z.:]+)(\/.*)?$/;
  const matchResult = pathStr.match(regex);
  if (!matchResult) {
    return ["", "", ""];
  }
  const protocol = matchResult[1];
  const host = matchResult[2];
  const realPath = CustomPathRewrite(proxyUrl, matchResult[3] || "/");
  return [protocol, host, realPath];
}

/**
 * CustomPathRewrite 函数
 * 用于修复路径中可能存在的畸形代理 URL 拼接，处理重定向或相对路径拼接产生的 "https/" 缺失冒号问题.
 * 将 .../https/www.x.com 变为 .../https://www.x.com .
 */
function CustomPathRewrite(proxyUrl: URL, path: string): string {
  for (const mark of Marks) {
    const checkMark = proxyUrl.href + mark;
    const markIndex = path.indexOf(checkMark);
    if (markIndex !== -1) {
      const afterPrefix = path.slice(markIndex + checkMark.length);
      return path.slice(0, markIndex) + markProto(mark) + "://" + afterPrefix;
    }
  }
  return path;
}

/**
 * Return "Set-Cookie" header of deleting a cookie.
 */
function deleteCookieHeader(name: string) {
  // 设置过期时间为 1970 年，强制浏览器删除
  return name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly";
}

/**
 * 构建真实请求的 Header，处理和清洗请求头。
 * @param {Headers} originalHeaders - 原始请求头对象
 * @param {string} targetProtocol - 目标协议 (http/https)
 * @param {string} targetHost - 目标主机 (www.google.com)
 * @returns {Promise<Object>} 处理后的普通对象格式的 Headers
 */
function processHeaders(
  proxyUrl: URL,
  originalHeaders: Headers,
  targetProtocol: string,
  targetHost: string
): [targetReqHeaders: Headers, directResponse?: Response] {
  const targetReqHeaders = new Headers();
  originalHeaders.forEach((value, key) => {
    key = key.toLowerCase();
    if (key.startsWith(HEADER_PREFIX_SITEPROXY) || key === HEADER_X_FORWARDED_FOR || key === HEADER_CF_CONNECTING_IP) {
      return;
    }
    targetReqHeaders.append(key, value);
  });
  targetReqHeaders.set(HEADER_HOST, targetHost);
  targetReqHeaders.set(HEADER_ACCEPT_ENCODING, "gzip");

  let directResponse: Response | undefined;
  const cookieStr = targetReqHeaders.get(HEADER_COOKIE);
  // --- Cookie 大小安全检查 ---
  if (cookieStr) {
    // 计算 Cookie 字节长度 (兼容 Node 和 Cloudflare Workers 环境)
    const byteLen = IS_NODE ? Buffer.byteLength(cookieStr) : new TextEncoder().encode(cookieStr).byteLength;
    // 如果 Cookie 超过 8000 字节，可能会导致服务器拒绝服务 (HTTP 431)
    // 这里的逻辑是：抛出一个特定错误，在外层捕获后，返回 Set-Cookie 指令让浏览器删除这些 Cookie
    if (byteLen > 8000) {
      const cookies = cookieStr.split(";").map((c) => c.trim().split("=", 2));
      const directResponseHeaders = new Headers();
      // 生成过期指令，清除除了代理自身配置 (proxy_real_) 以外的所有 Cookie
      cookies.forEach(([name]) => {
        directResponseHeaders.append(HEADER_SET_COOKIE, deleteCookieHeader(name));
      });
      directResponse = new Response(null, { headers: directResponseHeaders, status: 431 });
    }
  }

  // 4. --- Referer 和 Origin 重写逻辑 ---
  // 这一步非常关键，防止目标网站检测到防盗链
  if (targetReqHeaders.has(HEADER_SITEPROXY_NEWREFERER)) {
    // A. 优先使用 Service Worker 或前端脚本指定的自定义 Referer
    targetReqHeaders.set(HEADER_REFERER, targetReqHeaders.get(HEADER_SITEPROXY_NEWREFERER)!);
    try {
      const refUrl = new URL(targetReqHeaders.get(HEADER_SITEPROXY_NEWREFERER)!);
      targetReqHeaders.set(HEADER_ORIGIN, refUrl.origin);
    } catch (e) {
      // 忽略 URL 解析错误
    }
  } else if (targetReqHeaders.get(HEADER_REFERER)?.startsWith(proxyUrl.href)) {
    // Restore referer:
    // "https://proxy.com/token/https/www.google.com/foo" => "https/www.google.com/foo"
    const [realUrl] = restoreUrl(targetReqHeaders.get(HEADER_REFERER)!.slice(proxyUrl.href.length));
    targetReqHeaders.set(HEADER_REFERER, realUrl);
    targetReqHeaders.set(HEADER_ORIGIN, targetProtocol + "://" + targetHost);
  } else if (targetReqHeaders.get(HEADER_ORIGIN) === proxyUrl.origin) {
    // C. 如果 Origin 是代理服务器的域名 (常见于 AJAX/CORS 请求)，修正为目标域
    targetReqHeaders.set(HEADER_ORIGIN, targetProtocol + "://" + targetHost);
  }
  return [targetReqHeaders, directResponse];
}

function location_regex_replace(proxyUrl: URL, location: string): string {
  const rules: Record<string, string> = {
    "^(http[s]?)://([-a-zA-Z0-9.:]+)": proxyUrl.href + "$1://$2",
  };
  for (const regexStr in rules) {
    const regex = new RegExp(regexStr, "g");
    location = location.replace(regex, rules[regexStr]);
  }
  return location;
}

/**
 * modify response Location header
 */
function modLocation(proxyUrl: URL, targetUrl: URL, location: string): string {
  let newLocation = location_regex_replace(proxyUrl, location);
  if (newLocation.startsWith("/")) {
    newLocation = proxyUrl.href + targetUrl.protocol + "://" + targetUrl.host + newLocation;
  }
  return newLocation;
}

async function modResponse(proxyUrl: URL, mo: ResponseModOptions): Promise<Response> {
  let injectHtml = `
<script>
  if (!window.__SITEPROXY_INJECTED) {
    window.__SITEPROXY_PROXY_URL = '${proxyUrl.href}';
    window.__SITEPROXY_REAL_PROTOCOL = '${mo.targetUrl.protocol.slice(0, -1)}';
    window.__SITEPROXY_REAL_HOST = '${mo.targetUrl.host}';
    window.__SITEPROXY_HIDE_TOP = '${mo.HIDE_TOP || ""}';
    window.__SITEPROXY_DEBUG = '${mo.DEBUG || ""}';
  } 
</script>
`;
  if (
    mo.SCRIPT &&
    (!mo.SCRIPT_DOMAINS ||
      mo.SCRIPT_DOMAINS.split(/s*,\s*/).some((domain) => isBaseOrSubHost(mo.targetUrl.host, domain)))
  ) {
    const script = mo.SCRIPT.replace("{{domain}}", mo.targetUrl.hostname).replace("{{ts}}", String(Date.now()));
    injectHtml += `<script src="${script}"></script>\n`;
  }
  injectHtml += `<script src="/${PREFIX}inject.js"></script>\n`;

  if ([301, 302, 303, 307, 308].includes(mo.res.status)) {
    const location = mo.resHeaders.get(HEADER_LOCATION);
    if (location) {
      mo.resHeaders.set(HEADER_LOCATION, modLocation(proxyUrl, mo.targetUrl, location));
    }
  }

  const modifiedBody = await modifyContent(mo, injectHtml, compressFunc);
  return new Response(modifiedBody, { status: mo.res.status, headers: mo.resHeaders });
}

function findEndOfPatternInAsciiString(str: string, pattern: string) {
  const regex = new RegExp(pattern, "i");
  const result = regex.exec(str);
  if (result) {
    return result.index + result[0].length;
  } else {
    return -1;
  }
}

function replaceWindowLocationAssignments(html: string) {
  html = html.replace(/\bwindow\.location\s*=(.*?)/g, "window.___location=$1");
  html = html.replace(/\bwindow\.location\.href\s*=(.*?)/g, "window.___location=$1");
  html = html.replace(/\bwindow\.location\.assign\s*\((.*?)/g, "window.___location.assign($1");
  return html;
}

const DomainRegexMap = [
  {
    domain: "google.com",
    replacements: [
      {
        regex: /;\w+?\.integrity='sha.+?';/,
        replacement: ";",
      },
    ],
  },
];

const BodyRegexMap = [
  {
    regex: /\.URL\b/,
    replacement: ".___URL",
  },
  {
    regex: /\bdomain\b/,
    replacement: "___domain",
  },
  {
    regex: /\blocation\b/,
    replacement: "___location",
  },
  {
    regex: /\bpushState\b/,
    replacement: "___pushState",
  },
  {
    regex: /\breplaceState\b/,
    replacement: "___replaceState",
  },
  {
    regex: /\bnavigator.serviceWorker\b/,
    replacement: "navigator.___serviceWorker",
  },
  {
    regex: /\bdocument.requestStorageAccessFor\b/,
    replacement: "document.___requestStorageAccessFor",
  },
];

function modifyBody(targetUrl: URL, body: string) {
  let bodyStr = String(body);
  // if (typeof body === "string" && body.indexOf("document.URL") !== -1) {}
  DomainRegexMap.forEach((rule) => {
    if (isBaseOrSubHost(targetUrl.host, rule.domain)) {
      rule.replacements.forEach((replacement) => {
        bodyStr = bodyStr.replace(new RegExp(replacement.regex, "g"), replacement.replacement);
      });
    }
  });
  if (!BodyModHostBlacklist.some((host) => isBaseOrSubHost(targetUrl.host, host))) {
    BodyRegexMap.forEach(({ regex, replacement }) => {
      bodyStr = bodyStr.replace(new RegExp(regex, "g"), replacement);
    });
  }
  return bodyStr;
}

function invalidCookie(cookie: string): boolean {
  const i = cookie.indexOf(";");
  if (i !== -1) {
    const value = cookie.slice(0, i);
    if (value.indexOf("=") === -1) {
      return true;
    }
  }
  return false;
}

function cookieModify(cookie: string, replaceDomain: string) {
  const expiresRegex = /Expires=/i.test(cookie);
  const maxAgeRegex = /Max-Age=/i.test(cookie);
  let newCookie = cookie
    .replace(/Domain=[^;]*?(;|$)/gi, "Domain=" + replaceDomain + ";")
    .replace(/Path=([^;]*?)(;|$)/gi, "Path=/;");
  newCookie = newCookie.replace(/Max-Age=[^;]*?(;|$)/gi, "");
  const expiresValueMatch = newCookie.match(/Expires=([^;]*?)(;|$)/i);
  if (expiresValueMatch) {
    const h = expiresValueMatch[1];
    if (new Date(h) < new Date()) {
      newCookie = newCookie.replace(/Expires=[^;]*?(;|$)/gi, "");
      newCookie += "; Max-Age=1800";
    }
  } else if (!expiresRegex && !maxAgeRegex) {
    newCookie += "; Max-Age=1800";
  }
  if (!/Path=/i.test(newCookie)) {
    newCookie += "; Path=/;";
  }
  newCookie = newCookie.replace(/; ;|;;/g, ";");
  return newCookie;
}

function handleResponseHeaders(headers: Headers) {
  const newHeaders = new Headers();
  const setCookieHeaders: string[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== HEADER_SET_COOKIE) {
      newHeaders.set(name, value);
    } else {
      setCookieHeaders.push(value);
    }
  });
  setCookieHeaders.forEach((setCookieHeader: string) => {
    setCookieHeader.split(/,(?!(?:\s+[0-9]{2}))/).forEach((str) => {
      if (invalidCookie(str)) {
        return;
      }
      const newHeader = cookieModify(str, ProxyUrl.hostname);
      newHeaders.append(HEADER_SET_COOKIE, newHeader);
    });
  });
  newHeaders.delete(HEADER_CONTENT_SECURITY_POLICY);
  newHeaders.delete(HEADER_CONTENT_SECURITY_POLICY_REPORT_ONLY);
  newHeaders.delete(HEADER_X_FRAME_OPTIONS);
  return newHeaders;
}

/**
 * 修改响应内容 (核心注入逻辑)
 * @param {string} injectHtml - 需要注入到 HTML 中的 JS 代码片段 (<script>...</script>)
 * @param {Function} compressFunc - 压缩函数 (i)
 * @returns 修改后的响应体数据
 */
async function modifyContent(
  mo: ResponseModOptions,
  injectHtml: string,
  compressFunc?: CompressFunc
): Promise<BodyInit | null> {
  const { rawReqHeaders, resHeaders, res, targetUrl } = mo;
  let finalBody: BodyInit | null = res.body;
  const contentEncoding = res.headers.get(HEADER_CONTENT_ENCODING)?.toLowerCase() || "";
  // fetch transparently does de-compression
  resHeaders.delete(HEADER_CONTENT_ENCODING);
  resHeaders.delete(HEADER_TRANSFER_ENCODING);
  const fetchDest = rawReqHeaders.get(HEADER_SITEPROXY_DEST) || rawReqHeaders.get(HEADER_SEC_FETCH_DEST) || "";
  const contentDisposition = res.headers.get(HEADER_CONTENT_DISPOSITION)?.toLowerCase() || "";
  const contentType = res.headers.get(HEADER_CONTENT_TYPE)?.toLowerCase() || "";
  const isAttachment =
    contentDisposition === CONTENT_DISPOSITION_ATTACHMENT ||
    contentDisposition.startsWith(CONTENT_DISPOSITION_ATTACHMENT + ";");
  const isHtml = contentType === MIME_HTML || contentType.startsWith(MIME_HTML + ";");
  const isJs =
    contentType == MIME_JS ||
    contentType == MIME_JS2 ||
    contentType.startsWith(MIME_JS + ";") ||
    contentType.startsWith(MIME_JS2 + ";");

  if (shouldLog(targetUrl.href, mo.DEBUG)) {
    console.log(`mc: url=${targetUrl.href}, dest=${fetchDest}, ce=${contentDisposition}, ct=${contentType}`);
  }
  // 核心修改逻辑：仅针对网页加载的 HTML 和 JS 且状态码正常的请求
  if (
    targetUrl.href.includes(FLAG_RAW) ||
    !fetchDest ||
    isAttachment ||
    res.status >= 500 ||
    !(
      (isHtml && (HTML_MODIFIABLE_FETCH_DEST_ as readonly string[]).includes(fetchDest)) ||
      (isJs && (JS_MODIFIABLE_FETCH_DEST as readonly string[]).includes(fetchDest))
    )
  ) {
    return finalBody;
  }

  let bodyContent: BodyInit | null = null;
  let charset = "utf-8";
  let bodyLength = 0;
  bodyContent = await res.arrayBuffer();
  bodyLength = bodyContent.byteLength;
  if (!bodyContent || res.status === 204 || bodyLength < 10) {
    return finalBody;
  }
  // 字符集检测 (Charset Detection) ---
  // 为了防止乱码，先用 iso-8859-1 (单字节) 解码，正则搜索 <meta charset="...">
  const isoDecoder = new TextDecoder("iso-8859-1");
  const rawString = isoDecoder.decode(bodyContent);

  // 尝试从 meta 标签获取 charset
  const metaMatch = rawString.match(/<meta\s+[^>]*charset\s*=\s*["']?([0-9a-zA-Z\-]+)["']?[^>]*>/i);
  if (isHtml && metaMatch && metaMatch[1]) {
    charset = metaMatch[1].toLowerCase();
  } else {
    // 尝试从 Content-Type Header 获取 charset
    const headerMatch = contentType.match(/charset=([^;]+)/i);
    if (headerMatch) {
      charset = headerMatch[1].toLowerCase();
    }
  }

  // GBK 特殊处理逻辑：如果转成 UTF-8 字符串再转回来可能会损坏，且处理复杂
  // 这里采用直接操作 Uint8Array 的方式进行注入
  const isGbk = contentType.toLowerCase().indexOf("gbk") !== -1;
  let textDecoder: TextDecoder;
  try {
    textDecoder = new TextDecoder(charset);
  } catch (e) {
    console.error("Unsupported charset, falling back to utf-8", e);
    textDecoder = new TextDecoder("utf-8");
  }

  let decodedBodyString: string;
  try {
    decodedBodyString = textDecoder.decode(bodyContent);
  } catch (e) {
    console.error("Decoding error occurred: ", e);
    return bodyContent;
  }

  let headTagPos = -1;
  if (isHtml && charset === "gbk") {
    // 在 rawString (iso-8859-1) 中查找 <head> 标签的位置
    const headPattern = "<head.*?>";
    headTagPos = findEndOfPatternInAsciiString(decodedBodyString, headPattern);
    if (headTagPos !== -1) {
      headTagPos += 1; // 移动到标签闭合处之后
    }
  }

  if (shouldLog(targetUrl.href, mo.DEBUG)) {
    console.debug(`mc: url=${targetUrl.href}, charset=${charset}, ct=${contentType}, headTagPos=${headTagPos}`);
  }

  // [分支 A] GBK 编码且找到了注入位置：直接二进制拼接
  if (isHtml && charset === "gbk" && headTagPos !== -1) {
    const encoder = new TextEncoder(); // 注入的脚本默认是 UTF-8，但在现代浏览器混排通常能工作，或者这里假设注入脚本纯 ASCII
    const scriptBuffer = encoder.encode(injectHtml);

    const totalLength = bodyContent.byteLength + scriptBuffer.byteLength;
    const newBuffer = new ArrayBuffer(totalLength);
    const newUint8 = new Uint8Array(newBuffer);

    const originalUint8 = new Uint8Array(bodyContent);
    const scriptUint8 = new Uint8Array(scriptBuffer);

    // 拼接: [Header部分] + [注入脚本] + [剩余Body]
    newUint8.set(originalUint8.subarray(0, headTagPos), 0);
    newUint8.set(scriptUint8, headTagPos);
    newUint8.set(originalUint8.subarray(headTagPos), headTagPos + scriptUint8.length);

    bodyContent = newBuffer;
  } else if (!BodyModHostBlacklist.some((host) => isBaseOrSubHost(targetUrl.host, host))) {
    // [分支 B] 常规编码 (UTF-8等) 且不在排除名单中
    if (isHtml || isJs) {
      bodyContent = decodedBodyString;

      // JS 文件特殊处理：重写 window.location 相关赋值
      if (isJs) {
        bodyContent = replaceWindowLocationAssignments(bodyContent);
      }

      // 全局 Body 替换：将正文中的 URL 替换为代理 URL
      bodyContent = modifyBody(targetUrl, bodyContent);

      // HTML 注入逻辑
      if (isHtml) {
        // console.log("content-encoding: " + contentEncoding);
        // console.log("Debug: Attempting HTML injection - checking for <head>, <body>, <html> tags");

        // 尝试注入到 <head>, <body> 或 <html> 标签中
        if (bodyContent.indexOf("<head") !== -1) {
          // console.log("Debug: Injecting into <head>");
          bodyContent = bodyContent.replace(/<head(.*?)>/, "<head$1>" + injectHtml);
        } else if (bodyContent.indexOf("<body") !== -1) {
          // console.log("Debug: Injecting into <body>");
          bodyContent = bodyContent.replace(/<body(.*?)>/, "<body$1>" + injectHtml);
        } else if (bodyContent.indexOf("<html") !== -1) {
          // console.log("Debug: Injecting into <html>");
          bodyContent = bodyContent.replace(/<html(.*?)>/, "<html$1>" + injectHtml);
        } else {
          // console.log("Debug: Falling back to replacing any closing tag");
          // 兜底策略：在任意闭合标签前注入
          bodyContent = bodyContent.replace(/(<\/[a-zA-Z0-9]+>)/, "$1" + injectHtml);
        }
      }

      // 修改完成后，重新编码回 UTF-8 Buffer
      const utf8Encoder = new TextEncoder();
      bodyContent = utf8Encoder.encode(bodyContent);
    }
  } else {
    if (shouldLog(targetUrl.href, mo.DEBUG)) {
      console.debug(`mc: url=${targetUrl.href}, Excluded from body modification`);
    }
  }

  if (contentEncoding && compressFunc) {
    try {
      bodyContent = await compressFunc(bodyContent, "gzip");
      if ((bodyContent as any)?.length) {
        resHeaders.set(HEADER_CONTENT_LENGTH, String((bodyContent as any).length));
      }
      resHeaders.set(HEADER_CONTENT_ENCODING, "gzip");
    } catch (e) {
      if (shouldLog(targetUrl.href, mo.DEBUG)) {
        console.log("mc: compression error", e);
      }
    }
  }
  finalBody = bodyContent;
  if ((finalBody as any)?.length) {
    resHeaders.set(HEADER_CONTENT_LENGTH, String((finalBody as any).length));
  }
  return finalBody;
}

const app = new Hono<Env>();

if (IS_NODE) {
  // serve-static only works in node.js.
  if (!globalThis.__dirname) {
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    // some platform may not support import.meta.url
    globalThis.__dirname = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : ".";
  }

  // static assets, served from "/".
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const assets = ["robots.txt", PREFIX + "inject.js", PREFIX + "sw.js"] as const;
  for (const asset of assets) {
    app.use("/" + asset, serveStatic({ path: __dirname + "/dist/" + asset }));
  }

  // serve proxy root html.
  app.use(ProxyUrl.pathname, serveStatic({ path: __dirname + `/dist/${PREFIX}index.html` }));
} else {
  // static assets served by wrangle.json ASSETS.

  // serve proxy root html from CF Workers assets binding.
  app.get(ProxyUrl.pathname, async (ctx) => {
    return ctx.env.ASSETS.fetch(new URL(ctx.req.url).origin + `/${PREFIX}index.html`);
  });
}

app.get(ProxyUrl.pathname + PREFIX + "api", (ctx) => {
  ctx.header(HEADER_CACHE_CONTROL, CACHE_CONTROL_NO_CACHE);
  const action = ctx.req.query("action") || "";
  switch (action) {
    case "clear": {
      ctx.header(HEADER_CLEAR_SITE_DATA, CLEAR_SITE_DATA_ALL);
      return ctx.redirect(ProxyUrl.pathname);
    }
    case "go": {
      // 用于 noscript 环境的首页 form 表单提交后通过后端跳转到对应页面。
      const url = fixInputUrl(ctx.req.query(VAR_URL));
      if (url) {
        return ctx.redirect(`${ProxyUrl.pathname}${url}`);
      }
    }
  }
  return ctx.text("invalid", 400);
});

app.get("*", async (ctx, next, deps = {}) => {
  const { DEBUG, HIDE_TOP, SCRIPT, SCRIPT_DOMAINS } = env<Bindings>(ctx);
  const urlObj = new URL(ctx.req.url);
  if (shouldLog(ctx.req.url, DEBUG)) {
    console.log("req", ctx.req.url);
  }
  if (!urlObj.pathname.startsWith(ProxyUrl.pathname)) {
    return next();
  }
  // 从 Path 中提取真实的目标 Protocol 和 Host
  // 例如: /https/google.com/search -> protocol: https, host: google.com
  const pathAfterToken = urlObj.pathname.slice(ProxyUrl.pathname.length);
  const [targetProtocol, targetHost, targetPathname] = pathname2Target(pathAfterToken, ProxyUrl);
  if (targetProtocol !== "http" && targetProtocol !== "https") {
    return next();
  }
  const targetSearch = rewriteSearchQuery(ProxyUrl, urlObj.search);
  const targetUrl = new URL(targetProtocol + "://" + targetHost + targetPathname + targetSearch);
  if (UrlKeywordBlacklist.some((keyword) => targetUrl.href.includes(keyword))) {
    return next();
  }
  const rawReqHeaders = ctx.req.raw.headers;
  const [reqHeaders, directResponse] = processHeaders(ProxyUrl, rawReqHeaders, targetProtocol, targetHost);
  if (directResponse) {
    return directResponse;
  }
  const reqBody = !(NO_REQUEST_BODY_METHODS as readonly string[]).includes(ctx.req.method)
    ? await ctx.req.arrayBuffer()
    : undefined;

  if (shouldLog(targetUrl.href, DEBUG)) {
    console.log("fetch", targetUrl.href, rawReqHeaders);
  }
  let res = await fetch(targetUrl, {
    method: ctx.req.method,
    headers: reqHeaders,
    body: reqBody,
    redirect: "manual",
  });

  // 处理响应 (Cookie重写, 内容注入等)
  // responseModification 会处理解压缩、字符集解码、HTML注入脚本等
  const resHeaders = handleResponseHeaders(res.headers);

  const modificationOptions: ResponseModOptions = {
    targetUrl,
    rawReqHeaders,
    reqHeaders,
    resHeaders,
    res,
    HIDE_TOP,
    DEBUG,
    SCRIPT,
    SCRIPT_DOMAINS,
  };
  res = await modResponse(ProxyUrl, modificationOptions);
  return res;
});

// for Cloudflare Workers.
export default app;

if (IS_NODE) {
  const { serve } = await import("@hono/node-server");
  try {
    serve({ fetch: app.fetch, hostname: "::", port: Port }, (info) => {
      console.log(`Http server is listening on ${info.address} addr ${info.port} port`);
    });
  } catch (err) {
    serve({ fetch: app.fetch, hostname: "0.0.0.0", port: Port }, (info) => {
      console.log(`Http server is listening on ${info.address} addr ${info.port} port`);
    });
  }
} else {
  // In Cloudflare Workers env the exported app is served by Cloudflare Worker directly.
}
