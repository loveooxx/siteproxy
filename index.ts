// Backend main script file for both Cloudflare Workers and node.js env.

import { Hono } from "hono";
import {
  PREFIX,
  FLAG_RAW,
  NO_REQUEST_BODY_METHODS,
  HEADER_ACCEPT_ENCODING,
  HEADER_CACHE_CONTROL,
  HEADER_CLEAR_SITE_DATA,
  HEADER_CONTENT_DISPOSITION,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_LENGTH,
  HEADER_CONTENT_TYPE,
  HEADER_COOKIE,
  HEADER_HOST,
  HEADER_LOCATION,
  HEADER_REFERER,
  HEADER_ORIGIN,
  HEADER_SEC_FETCH_DEST,
  HEADER_SET_COOKIE,
  HEADER_SITEPROXY_NEWREFERER,
  HEADER_SITEPROXY_DEST,
  HEADER_TRANSFER_ENCODING,
  HEADER_SITEPROXY_TARGET_PROTOCOL,
  HEADER_SITEPROXY_TARGET_HOST,
  HEADERS_REQ_PROXY,
  HEADERS_RES_SECURITY,
  HTML_MODIFIABLE_FETCH_DEST_,
  JS_MODIFIABLE_FETCH_DEST,
  CONTENT_DISPOSITION_ATTACHMENT,
  CACHE_CONTROL_NO_CACHE,
  CLEAR_SITE_DATA_ALL,
  MIME_HTML,
  MIME_JS,
  MIME_JS2,
  CONTENT_ENCODING_GZIP,
  CONTENT_ENCODING_BR,
  CONTENT_ENCODING_DEFLATE,
  CHARSET_UTF8,
  VAR_URL,
  Marks,
  CharsetAliases,
  markProto,
  restoreUrl,
  fixInputUrl,
  escapeRegExp,
  shouldLog,
  isBaseOrSubHost,
  str2int,
  string2SliceOrFlag,
  removeHeaderKeys,
  headerBaseValueIs,
} from "./lib";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      PROXY_URL?: string;
      ADDR?: string;
      PORT?: string;
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
    }
  }
}

const IS_NODE = typeof globalThis.addEventListener === "undefined";

const Port = parseInt(process.env.PORT || "") || 5006;
const Addr = process.env.ADDR || "0.0.0.0";

const HideTop = !!str2int(process.env.HIDE_TOP);
const Debug = string2SliceOrFlag(process.env.DEBUG);
const Script = process.env.SCRIPT || "";
const ScriptDomains = process.env.SCRIPT_DOMAINS ? process.env.SCRIPT_DOMAINS.split(/\s*,\s*/) : null;

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

type CompressFunc = (data: any, encoding: string) => Promise<any>;

// environment variables / bindings
type Bindings = {
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
  hideTop: boolean;
  debug: boolean | string[];
  script: string;
  scriptDomains: string[] | null;
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
        case CONTENT_ENCODING_GZIP:
          return zlib.gzip(data, cb);
        case CONTENT_ENCODING_BR:
          // Brotli 压缩率更高，但速度较慢，通常用于静态资源
          return zlib.brotliCompress(data, cb);
        case CONTENT_ENCODING_DEFLATE:
          return zlib.deflate(data, cb);
        default:
          return reject(`Unsupported compression encoding: ${encoding}`);
      }
    });
    return compressedData;
  };
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
 * @param {Headers} rawReqHeaders - 原始请求头对象
 * @returns {Promise<Object>} 处理后的普通对象格式的 Headers
 */
function processHeaders(
  proxyUrl: URL,
  targetUrl: URL,
  rawReqHeaders: Headers
): [reqHeaders: Headers, directResponse?: Response] {
  const reqHeaders = new Headers(rawReqHeaders);
  removeHeaderKeys(reqHeaders, HEADERS_REQ_PROXY);
  reqHeaders.set(HEADER_HOST, targetUrl.host);
  reqHeaders.set(HEADER_ACCEPT_ENCODING, CONTENT_ENCODING_GZIP);

  let directResponse: Response | undefined;
  const cookieStr = reqHeaders.get(HEADER_COOKIE);
  // --- Cookie 大小安全检查 ---
  if (cookieStr) {
    // 计算 Cookie 字节长度 (兼容 Node 和 Cloudflare Workers 环境)
    const byteLen = IS_NODE ? Buffer.byteLength(cookieStr) : new TextEncoder().encode(cookieStr).byteLength;
    // 如果 Cookie 超过 8000 字节，可能会导致服务器拒绝服务 (HTTP 431)
    if (byteLen > 8000) {
      const cookies = cookieStr.split(";").map((c) => c.trim().split("=", 2));
      const directResponseHeaders = new Headers();
      cookies.forEach(([name]) => {
        directResponseHeaders.append(HEADER_SET_COOKIE, deleteCookieHeader(name));
      });
      directResponse = new Response(null, { headers: directResponseHeaders, status: 431 });
    }
  }

  // 4. --- Referer 和 Origin 重写逻辑 ---
  // 这一步非常关键，防止目标网站检测到防盗链
  if (reqHeaders.has(HEADER_SITEPROXY_NEWREFERER)) {
    // A. 优先使用 Service Worker 或前端脚本指定的自定义 Referer
    reqHeaders.set(HEADER_REFERER, reqHeaders.get(HEADER_SITEPROXY_NEWREFERER)!);
    try {
      const refUrl = new URL(reqHeaders.get(HEADER_SITEPROXY_NEWREFERER)!);
      reqHeaders.set(HEADER_ORIGIN, refUrl.origin);
    } catch (e) {}
  } else if (reqHeaders.get(HEADER_REFERER)?.startsWith(proxyUrl.href)) {
    // Restore referer:
    // "https://proxy.com/token/https/www.google.com/foo" => "https/www.google.com/foo"
    const [realUrl] = restoreUrl(reqHeaders.get(HEADER_REFERER)!.slice(proxyUrl.href.length));
    reqHeaders.set(HEADER_REFERER, realUrl);
    reqHeaders.set(HEADER_ORIGIN, targetUrl.origin);
  } else if (reqHeaders.get(HEADER_ORIGIN) === proxyUrl.origin) {
    // C. 如果 Origin 是代理服务器的域名 (常见于 AJAX/CORS 请求)，修正为目标域
    reqHeaders.set(HEADER_ORIGIN, targetUrl.origin);
  }
  return [reqHeaders, directResponse];
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
    newLocation = proxyUrl.href + targetUrl.protocol + "//" + targetUrl.host + newLocation;
  }
  return newLocation;
}

async function modResponse(proxyUrl: URL, mo: ResponseModOptions): Promise<Response> {
  let injectHtml = `
<script>
  if (!window.__SITEPROXY_INJECTED) {
    window.__SITEPROXY_PROXY_URL = ${JSON.stringify(proxyUrl.href)};
    window.__SITEPROXY_REAL_PROTOCOL = ${JSON.stringify(mo.targetUrl.protocol.slice(0, -1))};
    window.__SITEPROXY_REAL_HOST = ${JSON.stringify(mo.targetUrl.host)};
    window.__SITEPROXY_HIDE_TOP = ${JSON.stringify(mo.hideTop)};
    window.__SITEPROXY_DEBUG = ${JSON.stringify(mo.debug)};
  } 
</script>
`;
  if (
    mo.script &&
    (!mo.scriptDomains || mo.scriptDomains.some((domain) => isBaseOrSubHost(mo.targetUrl.host, domain)))
  ) {
    const script = mo.script.replace("{{domain}}", mo.targetUrl.hostname).replace("{{ts}}", String(Date.now()));
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
  removeHeaderKeys(newHeaders, HEADERS_RES_SECURITY);
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
  const isAttachment = headerBaseValueIs(contentDisposition, CONTENT_DISPOSITION_ATTACHMENT);
  const isHtml = headerBaseValueIs(contentType, MIME_HTML);
  const isJs = headerBaseValueIs(contentType, MIME_JS) || headerBaseValueIs(contentType, MIME_JS2);

  if (shouldLog(targetUrl.href, mo.debug)) {
    console.log(`mc: url=${targetUrl.href}, dest=${fetchDest}, ce=${contentDisposition}, ct=${contentType}`);
  }
  // 核心修改逻辑：仅针对网页加载的 HTML 和 JS 且状态码正常的请求
  if (
    targetUrl.href.includes(FLAG_RAW) ||
    !fetchDest ||
    isAttachment ||
    res.status >= 500 ||
    BodyModHostBlacklist.some((host) => isBaseOrSubHost(targetUrl.host, host)) ||
    !(
      (isHtml && (HTML_MODIFIABLE_FETCH_DEST_ as readonly string[]).includes(fetchDest)) ||
      (isJs && (JS_MODIFIABLE_FETCH_DEST as readonly string[]).includes(fetchDest))
    )
  ) {
    if (shouldLog(targetUrl.href, mo.debug)) {
      console.log(`mc: direct return`);
    }
    return finalBody;
  }

  let bodyContent: BodyInit | null = null;
  let charset = CHARSET_UTF8;
  let bodyLength = 0;
  bodyContent = await res.arrayBuffer();
  bodyLength = bodyContent.byteLength;
  if (!bodyContent || res.status === 204 || bodyLength < 10) {
    return finalBody;
  }

  // Charset Detection.
  // fatal = false: decoder will substitute malformed data with a replacement character.
  const utf8Decoder = new TextDecoder(CHARSET_UTF8, { fatal: false });
  const utf8String = utf8Decoder.decode(bodyContent);
  // 尝试从 meta 标签获取 charset
  const metaMatch = utf8String.match(/<meta\s+[^>]*charset\s*=\s*["']?([0-9a-zA-Z\-]+)["']?[^>]*>/i);
  if (isHtml && metaMatch && metaMatch[1]) {
    charset = metaMatch[1].toLowerCase();
  } else {
    // 尝试从 Content-Type Header 获取 charset
    const headerMatch = contentType.match(/charset=([^;]+)/i);
    if (headerMatch) {
      charset = headerMatch[1].toLowerCase();
    }
  }
  if ((CharsetAliases as Record<string, string>)[charset]) {
    charset = (CharsetAliases as Record<string, string>)[charset];
  }
  if (shouldLog(targetUrl.href, mo.debug)) {
    console.log(`mc: detected_charset=${charset}`);
  }

  let decodedBodyString = utf8String;
  if (charset && charset !== CHARSET_UTF8) {
    try {
      const textDecoder = new TextDecoder(charset);
      decodedBodyString = textDecoder.decode(bodyContent);
    } catch (e) {
      if (shouldLog(targetUrl.href, mo.debug)) {
        console.log(`mc: invalid charset ${charset}: ${e}, fallback to utf-8`);
      }
    }
  }

  // If it's non-UTF8 html and head tag found: directly binary concatation. Don't modifyBody。
  let htmlHeadTagPos = -1;
  if (isHtml && charset && charset !== CHARSET_UTF8) {
    // find <head> in raw UTF-8 String.
    const headPattern = "<head.*?>";
    htmlHeadTagPos = findEndOfPatternInAsciiString(decodedBodyString, headPattern);
    if (htmlHeadTagPos !== -1) {
      htmlHeadTagPos += 1; // 移动到标签闭合处之后
      if (shouldLog(targetUrl.href, mo.debug)) {
        console.debug(`mc: headTagPos=${htmlHeadTagPos}`);
      }
      const scriptBuffer = new TextEncoder().encode(injectHtml);

      const totalLength = bodyContent.byteLength + scriptBuffer.byteLength;
      const newBuffer = new ArrayBuffer(totalLength);
      const newUint8 = new Uint8Array(newBuffer);

      const originalUint8 = new Uint8Array(bodyContent);
      const scriptUint8 = new Uint8Array(scriptBuffer);

      // 拼接: [Header部分] + [注入脚本] + [剩余Body]
      newUint8.set(originalUint8.subarray(0, htmlHeadTagPos), 0);
      newUint8.set(scriptUint8, htmlHeadTagPos);
      newUint8.set(originalUint8.subarray(htmlHeadTagPos), htmlHeadTagPos + scriptUint8.length);

      bodyContent = newBuffer;
    }
  }

  // fallback: string concatation.
  if (htmlHeadTagPos === -1) {
    bodyContent = decodedBodyString;

    // JS 文件特殊处理：重写 window.location 相关赋值
    if (isJs) {
      bodyContent = replaceWindowLocationAssignments(bodyContent);
    }
    // 全局 Body 替换：将正文中的 URL 替换为代理 URL
    bodyContent = modifyBody(targetUrl, bodyContent);

    // HTML 注入逻辑
    if (isHtml) {
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
    bodyContent = new TextEncoder().encode(bodyContent);
    resHeaders.set(HEADER_CONTENT_TYPE, (isHtml ? MIME_HTML : MIME_JS) + "; charset=" + CHARSET_UTF8);
  }

  if (contentEncoding && compressFunc) {
    try {
      bodyContent = await compressFunc(bodyContent, CONTENT_ENCODING_GZIP);
      if ((bodyContent as any)?.length) {
        resHeaders.set(HEADER_CONTENT_LENGTH, String((bodyContent as any).length));
      }
      resHeaders.set(HEADER_CONTENT_ENCODING, CONTENT_ENCODING_GZIP);
    } catch (e) {
      if (shouldLog(targetUrl.href, mo.debug)) {
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

app.all("*", async (ctx, next, deps = {}) => {
  const rawReqHeaders = ctx.req.raw.headers;
  const urlObj = new URL(ctx.req.url);
  if (shouldLog(ctx.req.url, Debug)) {
    console.log(`${ctx.req.method} ${ctx.req.url}`, rawReqHeaders);
  }
  let pathAfterToken = "";
  if (urlObj.pathname.startsWith(ProxyUrl.pathname) + "http") {
    // Extract real url from pathname.
    pathAfterToken = urlObj.pathname.slice(ProxyUrl.pathname.length);
  } else if (rawReqHeaders.get(HEADER_SITEPROXY_TARGET_PROTOCOL)) {
    // Extract real url from headers.
    const targetProtocol = rawReqHeaders.get(HEADER_SITEPROXY_TARGET_PROTOCOL) || "";
    const targetHost = rawReqHeaders.get(HEADER_SITEPROXY_TARGET_HOST) || "";
    pathAfterToken = targetProtocol + "://" + targetHost + urlObj.pathname;
  } else {
    return next();
  }
  const [targetProtocol, targetHost, targetPathname] = pathname2Target(pathAfterToken, ProxyUrl);
  if (targetProtocol !== "http" && targetProtocol !== "https") {
    return next();
  }
  const targetSearch = rewriteSearchQuery(ProxyUrl, urlObj.search);
  const targetUrl = new URL(targetProtocol + "://" + targetHost + targetPathname + targetSearch);
  if (UrlKeywordBlacklist.some((keyword) => targetUrl.href.includes(keyword))) {
    return next();
  }

  const [reqHeaders, directResponse] = processHeaders(ProxyUrl, targetUrl, rawReqHeaders);
  if (directResponse) {
    return directResponse;
  }
  const reqBody = !(NO_REQUEST_BODY_METHODS as readonly string[]).includes(ctx.req.method)
    ? await ctx.req.arrayBuffer()
    : undefined;

  if (shouldLog(targetUrl.href, Debug)) {
    console.log("fetch", targetUrl.href, reqHeaders);
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
    hideTop: HideTop,
    debug: Debug,
    script: Script,
    scriptDomains: ScriptDomains,
  };
  res = await modResponse(ProxyUrl, modificationOptions);
  return res;
});

// for Cloudflare Workers.
export default app;

if (IS_NODE) {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, hostname: Addr, port: Port }, (info) => {
    console.log(`Http server is listening on ${info.address} addr ${info.port} port`);
  });
} else {
  // In Cloudflare Workers env the exported app is served by Cloudflare Worker directly.
}
