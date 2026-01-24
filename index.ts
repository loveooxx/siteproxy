// Backend main script file for both Cloudflare Workers and node.js env.

import { type HonoRequest, Hono } from "hono";

const IS_NODE = typeof globalThis.addEventListener === "undefined";

const Port = parseInt(process.env.PORT || "") || 5006;

if (!process.env.PROXY_URL) {
  process.env.PROXY_URL = `http://localhost${Port !== 80 ? `:${Port}` : ""}/`;
  console.warn(`PROXY_URL not set, fallback to ${process.env.PROXY_URL}`);
  console.warn(`In production env, you should set it to to your server origin with optional path prefix`);
} else {
  console.log(`PROXY_URL: ${process.env.PROXY_URL}`);
}
const ProxyUrl = new URL(process.env.PROXY_URL);
ProxyUrl.search = "";
ProxyUrl.hash = "";
ProxyUrl.username = "";
ProxyUrl.password = "";
if (ProxyUrl.pathname === "" || ProxyUrl.pathname === "/") {
  ProxyUrl.pathname = "/"; // "/default/"
}

const FilterUrlList = ["telegram.org/service_worker.js", "elcomercio.pe", "exchangebank.com"] as const;

const BodyModifyExcludeHosts = ["telegram.org", "nga.178.com"] as const;

// For compatibility, define all headers as full lowercase form.
const HEADER_CONTENT_TYPE = "content-type";
const HEADER_CONTENT_LENGTH = "content-length";
const HEADER_CONTENT_ENCODING = "content-encoding";
const HEADER_TRANSFER_ENCODING = "transfer-encoding";
const HEADER_SET_COOKIE = "set-cookie";
const HEADER_COOKIE = "cookie";
const HEADER_X_FRAME_OPTIONS = "x-frame-options";
const HEADER_LOCATION = "location";
const HEADER_HOST = "host";
const HEADER_X_FORWARDED_FOR = "x-forwarded-for";
const HEADER_CF_CONNECTING_IP = "cf-connecting-ip";
const HEADER_SITEPROXY_NEWREFERER = "siteproxy-newreferer";
const HEADER_PREFIX_SITEPROXY = "siteproxy-";
const HEADER_CONTENT_SECURITY_POLICY = "content-security-policy";

const HEADER_ACCEPT_ENCODING = "Accept-Encoding";

const MIME_HTML = "text/html";
const MIME_JS = "application/javascript";
const MIME_JS2 = "text/javascript";

type CompressFunc = (data: any, encoding: string) => Promise<any>;

// environment variables / bindings
type Bindings = {
  HIDE_HEADER: string;
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
  proxyResponse: Response;
  newResHeaders: Headers;
  req: HonoRequest;
  targetProtocol: string;
  targetHost: string;
  hideHeader: boolean;
}

/**
 * Location header modify
 */
interface ResponseLocationHeaderModOptions {
  location_value: string;
  proxy_url_prefix: string;
  targetProtocol: string;
  targetHost: string;
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
      const cb = (err: any, result: any) => (err ? reject(err) : resolve(result));
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

/**
 * Convert str to int. If str is null / undefined / empty / invalid (NaN), return defaultValue
 * @param str
 * @param defaultValue Optional, default is 0 (zero).
 * @returns
 */
function str2int(str?: string | undefined | null, defaultValue = 0): number {
  if (!str) {
    return defaultValue;
  }
  const value = parseInt(str);
  if (isNaN(value)) {
    return defaultValue;
  }
  return value;
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

/**
 * 解析路径，一次性提取协议、主机和真实路径
 * @param pathStr 去除 token 前缀后的路径字符串 (如: "https/google.com/search?q=1")
 * @param proxyUrl 代理本身的 URL 对象 (用于 CustomPathRewrite 修复逻辑)
 * @returns [protocol, host, realPath]
 */
function pathname2Target(
  pathStr: string,
  proxyUrl: URL
): [targetProtocol: string, targetHost: string, targetPathname: string] {
  // 正则修改说明：
  // group 1: ([^:/?#]+)       -> 协议 (https)
  //          \/               -> 分隔符 /
  // group 2: ([-a-z0-9A-Z.]+) -> 主机 (google.com)
  // group 3: (.*)             -> 剩余路径 (/search?q=1)
  const regex = /^([^:/?#]+)\/([-a-z0-9A-Z.]+)(.*)/;

  const matchResult = pathStr.match(regex);

  if (matchResult) {
    const protocol = matchResult[1] || "";
    const host = matchResult[2] || "";
    let realPath = matchResult[3] || "";

    // 如果路径为空（例如只访问了 .../https/google.com），默认为 "/"
    if (!realPath) {
      realPath = "/";
    }

    // 在这里直接执行路径修复逻辑
    realPath = CustomPathRewrite(realPath, proxyUrl);

    return [protocol, host, realPath];
  }

  return ["", "", ""];
}

/**
 * CustomPathRewrite 函数
 * 用于修复路径中可能存在的畸形代理 URL 拼接，特别是处理重定向产生的 "https/" 缺失冒号问题
 */
function CustomPathRewrite(path: string, proxyUrl: URL): string {
  // 构造检测字符串
  const httpsCheck = proxyUrl.href + "https/"; // .../token/https/
  const httpCheck = proxyUrl.href + "http/"; // .../token/http/

  let resultPath = path;

  // 检查路径中是否包含了完整的代理前缀+https (这通常发生在错误的相对路径拼接中)
  let httpsIndex = path.indexOf(httpsCheck);
  if (httpsIndex !== -1) {
    // 截取后半部分
    let afterPrefix = path.substring(httpsIndex + httpsCheck.length);
    // 修复: 将 .../https/www.x.com 变为 .../https://www.x.com
    // 注意：这里的逻辑是将路径前面的部分保留，中间的协议部分修正
    // 原代码逻辑看起来是想把嵌套的代理路径解开或者标准化协议头
    resultPath = path.substring(0, httpsIndex) + "https://" + afterPrefix;
  }

  // 同理检查 http
  let httpIndex = path.indexOf(httpCheck);
  if (httpIndex !== -1 && httpsIndex === -1) {
    let afterPrefix = path.substring(httpIndex + httpCheck.length);
    resultPath = path.substring(0, httpIndex) + "http://" + afterPrefix;
  }

  return resultPath;
}

// 4. 构建真实请求的 Header
/**
 * 处理和清洗请求头
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
): Record<string, string> {
  // 2. 将 Headers 对象转换为普通 JS 对象 (因为 Headers 对象通常不可变或操作不便)
  let headers: Record<string, string> = {};
  originalHeaders.forEach((value, key) => {
    headers[key] = value;
  });

  // 3. --- Cookie 大小安全检查 ---
  // 查找 Cookie 头 (Header key 是不区分大小写的)
  let cookieStr = "";
  for (const key in headers) {
    if (key.toLowerCase() === HEADER_COOKIE) {
      cookieStr = headers[key];
      break;
    }
  }

  if (cookieStr) {
    // 计算 Cookie 字节长度 (兼容 Node 和 Cloudflare Workers 环境)
    const byteLen = IS_NODE ? Buffer.byteLength(cookieStr) : new TextEncoder().encode(cookieStr).byteLength;

    // 如果 Cookie 超过 8000 字节，可能会导致服务器拒绝服务 (HTTP 431)
    // 这里的逻辑是：抛出一个特定错误，在外层捕获后，返回 Set-Cookie 指令让浏览器删除这些 Cookie
    if (byteLen > 8000) {
      const cookies = cookieStr.split(";").map((c) => c.trim().split("=", 2));

      // 生成过期指令，清除除了代理自身配置 (proxy_real_) 以外的所有 Cookie
      const expireCookiesList = cookies
        .map(([name]) => {
          if (!name?.startsWith("proxy_real_")) {
            // 设置过期时间为 1970 年，强制浏览器删除
            return name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly";
          }
          return null;
        })
        .filter(Boolean);

      const errorObj = {
        type: "header_too_large",
        expireCookies: expireCookiesList,
      };
      throw errorObj; // 抛出异常，中断后续请求
    }
  }

  // 4. --- Referer 和 Origin 重写逻辑 ---
  // 这一步非常关键，防止目标网站检测到防盗链

  if (headers[HEADER_SITEPROXY_NEWREFERER]) {
    // A. 优先使用 Service Worker 或前端脚本指定的自定义 Referer
    headers.referer = headers[HEADER_SITEPROXY_NEWREFERER];
    try {
      const refUrl = new URL(headers[HEADER_SITEPROXY_NEWREFERER]);
      headers.origin = refUrl.origin;
    } catch (e) {
      // 忽略 URL 解析错误
    }
  } else if (headers.referer && headers.referer.startsWith(proxyUrl.href)) {
    // B. 如果 Referer 是代理地址，则将其还原为真实地址
    // 原始: https://proxy.com/token/https/www.google.com/foo
    // 截取后: https/www.google.com/foo

    headers.referer = headers.referer.substring(proxyUrl.href.length);

    // 去除开头的斜杠
    if (headers.referer.startsWith("/")) {
      headers.referer = headers.referer.substring(1);
    }

    // 还原协议部分的写法 (https/ -> https://)
    if (headers.referer.startsWith("https/")) {
      headers.referer = "https://" + headers.referer.substring(6);
    } else if (headers.referer.startsWith("http/")) {
      headers.referer = "http://" + headers.referer.substring(5);
    }

    // 修正 Origin 为目标协议+主机
    headers.origin = targetProtocol + "://" + targetHost;
  } else if (headers.origin === proxyUrl.origin) {
    // C. 如果 Origin 是代理服务器的域名 (常见于 AJAX/CORS 请求)，修正为目标域
    headers.origin = targetProtocol + "://" + targetHost;
  }

  return headers;
}

function location_regex_replace({ location_value, proxy_url_prefix }: ResponseLocationHeaderModOptions): string {
  const rules: Record<string, string> = {
    "^(http[s]?)://([-a-zA-Z0-9.]+)": proxy_url_prefix + "$1/$2",
  };
  for (const regexStr in rules) {
    const regex = new RegExp(regexStr, "g");
    location_value = location_value.replace(regex, rules[regexStr]);
  }
  return location_value;
}

function modifyResponseLocationHeader(location: ResponseLocationHeaderModOptions) {
  let newLocation = location_regex_replace(location);
  if (newLocation.startsWith("/")) {
    newLocation = location.proxy_url_prefix + location.targetProtocol + "/" + location.targetHost + newLocation;
  }
  return newLocation;
}

function handleRedirects(
  proxyResponse: Response,
  newResHeaders: Headers,
  proxyUrlFull: string,
  targetProtocol: string,
  targetHost: string
) {
  if ([301, 302, 303, 307, 308].includes(proxyResponse.status)) {
    let locationHeader = proxyResponse.headers.get(HEADER_LOCATION);
    if (locationHeader) {
      const locationMod: ResponseLocationHeaderModOptions = {
        location_value: locationHeader,
        proxy_url_prefix: proxyUrlFull,
        targetProtocol,
        targetHost,
      };
      newResHeaders.set(HEADER_LOCATION, modifyResponseLocationHeader(locationMod));
    }
  }
}

async function modResponse(
  proxyUrl: URL,
  { proxyResponse, newResHeaders, targetProtocol, targetHost, hideHeader }: ResponseModOptions
) {
  // 注入的脚本内容：设置全局变量，加载 Service Worker 注册脚本
  const injectionScript = `
  <script>
    if (!window.__SITEPROXY_INJECTED__) { 
      window.__SITEPROXY_PROXY_URL__ = '${proxyUrl.href}';
      window.__SITEPROXY_REAL_PROTOCOL__ = '${targetProtocol}';
      window.__SITEPROXY_REAL_HOST__ = '${targetHost}';
      window.__SITEPROXY_HIDE_HEADER__ = ${hideHeader};
    } 
  </script>
  <script src="/__siteproxy_injected__.js"></script>`;

  // 处理重定向 (301/302 Location 头重写)
  handleRedirects(proxyResponse, newResHeaders, proxyUrl.href, targetProtocol, targetHost);

  // 修改响应体内容
  let modifiedBody: BodyInit | null | undefined = await modifyContent(
    proxyUrl,
    proxyResponse,
    newResHeaders,
    injectionScript,
    targetProtocol,
    targetHost,
    compressFunc
  );

  // 如果状态码是 3xx 或 204，不需要 Body
  if (proxyResponse.status === 204 || [301, 302, 303, 304, 307, 308].includes(proxyResponse.status)) {
    modifiedBody = undefined;
    newResHeaders.delete(HEADER_CONTENT_LENGTH);
    newResHeaders.delete(HEADER_CONTENT_ENCODING);
  }

  return new Response(modifiedBody, {
    status: proxyResponse.status,
    headers: newResHeaders,
  });
}

function findEndOfPatternInAsciiString(str: string, pattern: string) {
  const c = new RegExp(pattern, "i");
  const d = c.exec(str);
  if (d) {
    return d.index + d[0].length;
  } else {
    return -1;
  }
}

function replaceWindowLocationAssignments(html: string) {
  html = html.replace(/\bwindow\.location\s*=(.*?)/g, "window.hookLocation=$1");
  html = html.replace(/\bwindow\.location\.href\s*=(.*?)/g, "window.hookLocation=$1");
  html = html.replace(/\bwindow\.location\.assign\s*\((.*?)/g, "window.hookLocation.assign($1");
  return html;
}

const domainRegexMap = [
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

const bodyRegexMap = [
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

function isExcludedForBodyModify(host: string) {
  return BodyModifyExcludeHosts.some((exclude) => exclude.includes(host));
}

function modifyBody(body: any, targetHost: string, proxyFullUrl: string) {
  let bodyStr = String(body);
  // if (typeof body === "string" && body.indexOf("document.URL") !== -1) {}
  domainRegexMap.forEach((rule) => {
    if (targetHost.includes(rule.domain)) {
      rule.replacements.forEach((replacement) => {
        bodyStr = bodyStr.replace(new RegExp(replacement.regex, "g"), replacement.replacement);
      });
    }
  });
  if (!isExcludedForBodyModify(targetHost)) {
    bodyRegexMap.forEach(({ regex, replacement }) => {
      bodyStr = bodyStr.replace(new RegExp(regex, "g"), replacement);
    });
  }
  return bodyStr;
}

function invalidCookie(cookie: string): boolean {
  let i = cookie.indexOf(";");
  if (i !== -1) {
    let value = cookie.substring(0, i);
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
  let newHeaders = new Headers();
  let setCookieHeaders: string[] = [];
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
      let newHeader = cookieModify(str, ProxyUrl.hostname);
      newHeaders.append(HEADER_SET_COOKIE, newHeader);
    });
  });
  newHeaders.delete(HEADER_CONTENT_SECURITY_POLICY);
  return newHeaders;
}

/**
 * 修改响应内容 (核心注入逻辑)
 * @param {Response} proxyResponse - 原始的代理响应对象
 * @param {Headers} resHeaders - 准备返回给客户端的新响应头
 * @param {string} injectionScript - 需要注入到 HTML 中的 JS 代码片段 (<script>...</script>)
 * @param {Function} compressFunc - 压缩函数 (i)
 * @returns 修改后的响应体数据
 */
async function modifyContent(
  proxyUrl: URL,
  proxyResponse: Response,
  resHeaders: Headers,
  injectionScript: string,
  targetProtocol: string,
  targetHost: string,
  compressFunc?: CompressFunc
): Promise<BodyInit> {
  // bodyContent 将存储最终的二进制数据或字符串
  let bodyContent: any;

  // 2. 获取响应头信息
  const contentEncoding = proxyResponse.headers.get(HEADER_CONTENT_ENCODING);
  const contentType = (proxyResponse.headers.get(HEADER_CONTENT_TYPE) || "").toLowerCase();
  const isHtml = contentType === MIME_HTML || contentType.startsWith(MIME_HTML + ";");
  const isJs =
    contentType == MIME_JS ||
    contentType == MIME_JS2 ||
    contentType.startsWith(MIME_JS + ";") ||
    contentType.startsWith(MIME_JS2 + ";");

  // 默认直接使用原始流，如果不需要修改
  let finalBody: any = proxyResponse.body;
  let charset = "utf-8";
  let bodyLength = 0;

  // 3. 读取响应体
  // 如果有压缩标识(gzip等)，或者内容是HTML/JS，我们需要读取整个 buffer 进行处理
  if (contentEncoding) {
    bodyContent = await proxyResponse.arrayBuffer();
    bodyLength = bodyContent.byteLength;
  }

  // 4. 核心修改逻辑：仅针对 HTML 和 JS 且状态码正常的请求
  if ((isHtml || isJs) && proxyResponse.status < 500) {
    // 如果之前没读过 buffer (非压缩情况)，现在读取
    if (!contentEncoding) {
      bodyContent = await proxyResponse.arrayBuffer();
      bodyLength = bodyContent.byteLength;
    }

    // 边界检查：如果内容太短或为空，直接返回
    if (!bodyLength || bodyLength < 10) {
      if (!bodyLength || proxyResponse.status === 204) {
        bodyContent = undefined;
        return bodyContent;
      }
    }

    // --- 字符集检测 (Charset Detection) ---
    // 为了防止乱码，先用 iso-8859-1 (单字节) 解码，正则搜索 <meta charset="...">
    const isoDecoder = new TextDecoder("iso-8859-1");
    const rawString = isoDecoder.decode(bodyContent);

    // 尝试从 meta 标签获取 charset
    let metaMatch = rawString.match(/<meta\s+[^>]*charset\s*=\s*["']?([0-9a-zA-Z\-]+)["']?[^>]*>/i);
    if (isHtml && metaMatch && metaMatch[1]) {
      charset = metaMatch[1].toLowerCase();
    } else {
      // 尝试从 Content-Type Header 获取 charset
      const headerMatch = contentType.match(/charset=([^;]+)/i);
      if (headerMatch) {
        charset = headerMatch[1].toLowerCase();
      }
    }

    // --- GBK 特殊处理逻辑 ---
    // GBK 编码如果转成 UTF-8 字符串再转回来可能会损坏，且处理复杂
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

    // console.debug(`modifyContent: charset=${charset}, contentType=${contentType}, headTagPos=${headTagPos}`);

    // [分支 A] GBK 编码且找到了注入位置：直接二进制拼接
    if (isHtml && charset === "gbk" && headTagPos !== -1) {
      const encoder = new TextEncoder(); // 注入的脚本默认是 UTF-8，但在现代浏览器混排通常能工作，或者这里假设注入脚本纯 ASCII
      let scriptBuffer = encoder.encode(injectionScript);

      let totalLength = bodyContent.byteLength + scriptBuffer.byteLength;
      let newBuffer = new ArrayBuffer(totalLength);
      let newUint8 = new Uint8Array(newBuffer);

      let originalUint8 = new Uint8Array(bodyContent);
      let scriptUint8 = new Uint8Array(scriptBuffer);

      // 拼接: [Header部分] + [注入脚本] + [剩余Body]
      newUint8.set(originalUint8.subarray(0, headTagPos), 0);
      newUint8.set(scriptUint8, headTagPos);
      newUint8.set(originalUint8.subarray(headTagPos), headTagPos + scriptUint8.length);

      bodyContent = newBuffer;
    } else if (!isExcludedForBodyModify(targetHost)) {
      // [分支 B] 常规编码 (UTF-8等) 且不在排除名单中
      if (isHtml || isJs) {
        bodyContent = decodedBodyString;

        // JS 文件特殊处理：重写 window.location 相关赋值
        if (isJs) {
          bodyContent = replaceWindowLocationAssignments(bodyContent);
        }

        // 全局 Body 替换：将正文中的 URL 替换为代理 URL
        bodyContent = modifyBody(bodyContent, targetHost, proxyUrl.href);

        // HTML 注入逻辑
        if (isHtml) {
          // console.log("content-encoding: " + contentEncoding);
          // console.log("Debug: Attempting HTML injection - checking for <head>, <body>, <html> tags");

          // 尝试注入到 <head>, <body> 或 <html> 标签中
          if (bodyContent.indexOf("<head") !== -1) {
            // console.log("Debug: Injecting into <head>");
            bodyContent = bodyContent.replace(/<head(.*?)>/, "<head$1>" + injectionScript);
          } else if (bodyContent.indexOf("<body") !== -1) {
            // console.log("Debug: Injecting into <body>");
            bodyContent = bodyContent.replace(/<body(.*?)>/, "<body$1>" + injectionScript);
          } else if (bodyContent.indexOf("<html") !== -1) {
            // console.log("Debug: Injecting into <html>");
            bodyContent = bodyContent.replace(/<html(.*?)>/, "<html$1>" + injectionScript);
          } else {
            // console.log("Debug: Falling back to replacing any closing tag");
            // 兜底策略：在任意闭合标签前注入
            bodyContent = bodyContent.replace(/(<\/[a-zA-Z0-9]+>)/, "$1" + injectionScript);
          }
        }

        // 修改完成后，重新编码回 UTF-8 Buffer
        const utf8Encoder = new TextEncoder();
        bodyContent = utf8Encoder.encode(bodyContent);
      }
    } else {
      // console.log("Debug: Excluded from body modification");
    }

    // 5. 设置 Cookie 用于客户端脚本识别
    if (targetProtocol) {
      const cookieProtocol = "proxy_real_protocol=" + targetProtocol + "; Path=/; HttpOnly";
      const cookieHost = "proxy_real_host=" + targetHost + "; Path=/; HttpOnly";
      resHeaders.append(HEADER_SET_COOKIE, cookieProtocol);
      resHeaders.append(HEADER_SET_COOKIE, cookieHost);
      // 删除 X-Frame-Options 以允许在 iframe 中加载（如果代理是用 iframe 实现的）
      resHeaders.delete(HEADER_X_FRAME_OPTIONS);
    }

    finalBody = bodyContent;
  }

  // 6. 重新压缩处理
  // 如果原响应是压缩的 (gzip)，我们修改了解压后的内容，现在必须重新压缩回去
  // 否则浏览器看到 Content-Encoding: gzip 却收到明文会报错
  if (contentEncoding) {
    let compressed = false;
    if (compressFunc) {
      try {
        bodyContent = await compressFunc(bodyContent, "gzip");
        resHeaders.set(HEADER_CONTENT_LENGTH, String(bodyContent.length));
        resHeaders.set(HEADER_CONTENT_ENCODING, "gzip");
        compressed = true;
      } catch (e) {
        console.log(e);
      }
    }
    if (!compressed) {
      // Cloudflare 环境或压缩失败: 删除压缩相关 headers
      resHeaders.delete(HEADER_CONTENT_ENCODING);
      resHeaders.delete(HEADER_TRANSFER_ENCODING);
    }
    finalBody = bodyContent;
  }

  // 7. 更新 Content-Length
  if (finalBody?.length) {
    resHeaders.set(HEADER_CONTENT_LENGTH, String(finalBody.length));
  }

  // 确保返回 Uint8Array
  if (finalBody instanceof ArrayBuffer) {
    finalBody = new Uint8Array(finalBody);
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
  app.use("/__siteproxy_injected__.js", serveStatic({ path: __dirname + "/assets/__siteproxy_injected__.js" }));
  app.use(
    "/__siteproxy_service_worker__.js",
    serveStatic({ path: __dirname + "/assets/__siteproxy_service_worker__.js" })
  );

  // serve proxy root html.
  app.use(ProxyUrl.pathname, serveStatic({ path: __dirname + "/assets/__siteproxy_index__.html" }));
} else {
  // static assets served by wrangle.json ASSETS

  // serve proxy root html from CF Workers assets binding.
  app.get(ProxyUrl.pathname, async (ctx) => {
    return ctx.env.ASSETS.fetch(new URL(ctx.req.url).origin + "/__siteproxy_index__.html");
  });
}

app.get(ProxyUrl.pathname + "__siteproxy_api__", (ctx) => {
  const action = ctx.req.query("action") || "";
  switch (action) {
    case "go": {
      // 用于 noscript 环境的首页 form 表单提交后通过后端跳转到对应页面。
      let url = ctx.req.query("url");
      if (url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          url = "https://" + url;
        }
        try {
          const targetUrl = new URL(url);
          if (targetUrl.protocol === "http:" || targetUrl.protocol === "https:") {
            return ctx.redirect(`${ProxyUrl.pathname}${targetUrl.href.replace("://", "/")}`);
          }
        } catch (e) {}
      }
    }
  }
  return ctx.text("invalid", 400);
});

app.get("*", async (ctx, next, deps = {}) => {
  let { req, res } = ctx;

  // 1. 检查是否在过滤名单中
  if (FilterUrlList.some((item) => req.url.includes(item))) {
    return next();
  }

  // 2. 解析请求路径
  let urlObj = new URL(req.url);
  if (!urlObj.pathname.startsWith(ProxyUrl.pathname)) {
    return next();
  }

  // 3. 从 Path 中提取真实的目标 Protocol 和 Host
  // 例如: /default/https/google.com/search -> protocol: https, host: google.com
  let pathAfterToken = urlObj.pathname.substring(ProxyUrl.pathname.length);
  let [targetProtocol, targetHost, targetPathname] = pathname2Target(pathAfterToken, ProxyUrl);

  if (targetProtocol !== "http" && targetProtocol !== "https") {
    return next();
  }

  const targetFullUrl = targetProtocol + "://" + targetHost + targetPathname + urlObj.search;
  const targetHeaders = processHeaders(ProxyUrl, req.raw.headers, targetProtocol, targetHost);

  // 转换为 Fetch 需要的 Headers 对象
  const fetchHeaders = new Headers();
  for (const key in targetHeaders) {
    fetchHeaders.append(key, targetHeaders[key]);
  }

  const requestBody = req.method !== "GET" ? await req.arrayBuffer() : undefined;

  // 6. 清理代理特有的 Headers
  removeSiteproxyHeaders(fetchHeaders);
  fetchHeaders.set(HEADER_HOST, targetHost);
  fetchHeaders.set(HEADER_ACCEPT_ENCODING, "gzip"); // 强制 gzip 以便后续处理

  // 7. 发起真实请求 (Fetch)
  const proxyResponse = await fetch(targetFullUrl, {
    method: req.method,
    headers: fetchHeaders,
    body: requestBody,
    redirect: "manual",
  });

  // 8. 处理响应 (Cookie重写, 内容注入等)
  // responseModification 会处理解压缩、字符集解码、HTML注入脚本等
  const modifiedResHeaders = handleResponseHeaders(proxyResponse.headers); // 简化的函数名

  const modificationOptions: ResponseModOptions = {
    proxyResponse,
    newResHeaders: modifiedResHeaders,
    req,
    targetProtocol: targetProtocol,
    targetHost: targetHost,
    hideHeader: !!str2int(ctx.env.HIDE_HEADER),
  };

  ctx.res = await modResponse(ProxyUrl, modificationOptions);
  return ctx.res;
});

// for Cloudflare Workers.
export default app;

if (IS_NODE) {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, hostname: "0.0.0.0", port: Port }, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  });
} else {
  // In Cloudflare Workers env the exported app is served by Cloudflare Worker directly.
}
