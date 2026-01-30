// Client service worker file.

import {
  type ProxyMsg,
  PREFIX,
  FLAG_DIRECT,
  WITH_REQUEST_BODY_METHODS,
  HEADER_CONTENT_TYPE,
  HEADER_CONTENT_ENCODING,
  HEADER_SITEPROXY_NEWREFERER,
  HEADER_SITEPROXY_REAL_REFERER,
  HEADER_SITEPROXY_TARGET_HOST,
  HEADER_SITEPROXY_TARGET_PROTOCOL,
  HEADER_SITEPROXY_DEST,
  FETCH_DEST_DOCUMENT,
  MIME_FORM,
  MIME_JSON,
  MIME_MULTIPART_FORM,
  MIME_CAT_PREFIX_TEXT,
  VAR_PROXY_URL,
  VAR_PROXY_REAL_PROTOCOL,
  VAR_PROXY_REAL_HOST,
  VAR_PROXY_DEBUG,
  escapeRegExp,
  restoreUrl,
  shouldLog,
  string2SliceOrFlag,
  headerBaseValueIs,
} from "./lib";

declare const self: ServiceWorkerGlobalScope;

const Params = new URLSearchParams(location.search);
const ProxyUrl = new URL(Params.get(VAR_PROXY_URL)!); // Let URL constructor through error if invalid
const ProxyRealProtocol = Params.get(VAR_PROXY_REAL_PROTOCOL) || "";
const ProxyRealHost = Params.get(VAR_PROXY_REAL_HOST) || "";
const ProxyDebug = string2SliceOrFlag(Params.get(VAR_PROXY_DEBUG));
let ProxyTargetProtocol = "";
let ProxyTargetHost = "";

console.log("Service Worker", ProxyUrl.href, ProxyRealProtocol, ProxyRealHost);

/**
 * Cacha valid time in miniseconds. 30s.
 */
const CACHE_LIFETIME = 30000;

const CACHE_CLEAR_INTERVAL = 2000;

interface HostCache {
  /**
   * "https"
   */
  real_protocol: string;
  /**
   * "example.com"
   */
  real_host: string;
  /**
   * unix timestamp in miniseconds
   */
  lasttime: number;
}

/**
 * 全局变量：URL 映射缓存. key: host.
 */
const HostCache: Record<string, HostCache> = {};

/**
 * 定时任务：清理过期的缓存
 */
function cleanCache() {
  const now = Date.now();
  for (const path in HostCache) {
    if (now > HostCache[path].lasttime + CACHE_LIFETIME) {
      delete HostCache[path];
    }
  }
}

setInterval(cleanCache, CACHE_CLEAR_INTERVAL);

// --- 辅助函数：重写内容中的 URL ---
// 将响应内容中的原始链接替换为代理链接，恢复 location 等对象
function rewriteUrlsInContent(content: string) {
  // 将 "/path_prefix/http/___" 格式的链接还原
  // $1 : protocol; $2: host.
  content = content.replaceAll(new RegExp(escapeRegExp(ProxyUrl.href) + "(https?)(?:://|/)([^/]+)", "g"), "$1://$2");

  // 恢复被混淆的 JS 属性
  content = content.replaceAll("___location", "location");
  content = content.replaceAll("___URL", "URL");
  content = content.replaceAll("___domain", "domain");
  content = content.replaceAll("navigator.___serviceWorker", "navigator.serviceWorker");
  content = content.replaceAll("document.___requestStorageAccessFor", "document.requestStorageAccessFor");
  return content;
}

// --- Service Worker 消息监听 ---
self.addEventListener("message", (event) => {
  if (!event.data) {
    return;
  }
  const data: ProxyMsg = event.data;
  if (data.type === "PROXY_CUR_LOCATION") {
    // 更新当前页面的目标协议和主机
    const { protocol, host } = data.data;
    if (protocol && host && (protocol !== ProxyTargetProtocol || host !== ProxyTargetHost)) {
      ProxyTargetProtocol = protocol;
      ProxyTargetHost = host;
    }
  } else if (data.type === "PROXY_URL_HOST_MAP") {
    // 缓存特定路径对应的真实主机信息
    HostCache[data.data.pathname] = {
      real_protocol: data.data.real_protocol,
      real_host: data.data.real_host,
      lasttime: Date.now(),
    };
  }
});

// --- Service Worker 安装与激活 ---
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// --- 核心逻辑：拦截 Fetch 请求 ---
self.addEventListener("fetch", (event) => {
  let debug = shouldLog(event.request.url, ProxyDebug);
  if (debug) {
    console.log(">> sw fetch", event.request.method, event.request.url);
  }
  event.respondWith(
    (async () => {
      let targetUrl = new URL(event.request.url);
      let targetProtocol = "";
      let targetHost = "";
      const searchParams = rewriteUrlsInContent(targetUrl.search);
      if (targetUrl.origin === location.origin) {
        if (
          targetUrl.pathname.startsWith("/" + PREFIX) ||
          targetUrl.pathname.startsWith(ProxyUrl.pathname + PREFIX) ||
          targetUrl.pathname === ProxyUrl.pathname ||
          targetUrl.pathname === "/robots.txt" ||
          targetUrl.href.includes(FLAG_DIRECT)
        ) {
          if (debug) {
            console.log("sw direct fetch");
          }
          return fetch(event.request);
        }
        if (targetUrl.pathname.startsWith(ProxyUrl.pathname)) {
          const [realUrl, found] = restoreUrl(targetUrl.pathname.slice(ProxyUrl.pathname.length));
          if (found) {
            targetUrl = new URL(realUrl);
            targetProtocol = targetUrl.protocol.slice(0, -1);
            targetHost = targetUrl.host;
          }
        }
        if (!targetProtocol) {
          if (event.request.destination === FETCH_DEST_DOCUMENT && !event.request.referrer) {
            if (debug) {
              console.log("sw direct document fetch");
            }
            return fetch(event.request);
          }
          targetProtocol = ProxyTargetProtocol || ProxyRealProtocol;
          targetHost = ProxyTargetHost || ProxyRealHost;
        }
      } else {
        targetProtocol = targetUrl.protocol.slice(0, -1);
        targetHost = targetUrl.host;
      }
      let targetReferer = targetProtocol + "://" + targetHost;
      const requestHeaders = new Headers(event.request.headers);

      if (requestHeaders.get(HEADER_SITEPROXY_TARGET_HOST)) {
        targetProtocol = requestHeaders.get(HEADER_SITEPROXY_TARGET_PROTOCOL) || "";
        targetHost = requestHeaders.get(HEADER_SITEPROXY_TARGET_HOST) || "";
        targetReferer = requestHeaders.get(HEADER_SITEPROXY_REAL_REFERER) || "";
      }
      requestHeaders.set(HEADER_SITEPROXY_DEST, event.request.destination);
      requestHeaders.set(HEADER_SITEPROXY_NEWREFERER, targetReferer);

      const finalUrl = ProxyUrl.href + targetProtocol + "://" + targetHost + targetUrl.pathname + searchParams;
      debug = shouldLog(finalUrl, ProxyDebug);
      if (debug) {
        console.log(`sw fetch targetUrl=${targetUrl}, proxy_url=${ProxyUrl}, finalUrl=${finalUrl}`);
      }
      const fetchOptions: RequestInit = {
        method: event.request.method,
        headers: requestHeaders,
        mode: "cors",
        credentials: "include", // 包含 Cookie
        redirect: event.request.redirect,
      };
      // Process request body
      if ((WITH_REQUEST_BODY_METHODS as readonly string[]).includes(event.request.method.toUpperCase())) {
        const clonedRequest = event.request.clone();
        const contentType = clonedRequest.headers.get(HEADER_CONTENT_TYPE)?.toLowerCase() || "";
        const contentEncoding = clonedRequest.headers.get(HEADER_CONTENT_ENCODING)?.toLowerCase() || "";

        // 如果是文本类数据 (JSON/Text/Form) 且未被压缩
        if (
          !contentEncoding &&
          contentType &&
          (contentType.startsWith(MIME_CAT_PREFIX_TEXT) ||
            headerBaseValueIs(contentType, MIME_FORM) ||
            headerBaseValueIs(contentType, MIME_JSON))
        ) {
          let bodyText = await clonedRequest.text();
          // 重写 Body 里的 URL
          bodyText = rewriteUrlsInContent(bodyText);
          fetchOptions.body = bodyText;
        } else if (headerBaseValueIs(contentType, MIME_MULTIPART_FORM)) {
          // multipart/form-data 需要特殊处理
          const formData = await clonedRequest.formData();
          const newFormData = new FormData();
          for (const [key, value] of formData.entries()) {
            if (typeof value === "string") {
              newFormData.append(key, rewriteUrlsInContent(value));
            } else {
              newFormData.append(key, value);
            }
          }
          fetchOptions.body = newFormData;
        } else {
          // 二进制数据直接透传
          const bodyBuffer = await clonedRequest.arrayBuffer();
          fetchOptions.body = bodyBuffer;
        }
      }
      const newRequest = new Request(finalUrl, fetchOptions);
      return fetch(newRequest);
    })()
  );
});
