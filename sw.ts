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
  VAR_PROXY_URL,
  VAR_PROXY_REAL_PROTOCOL,
  VAR_PROXY_REAL_HOST,
  VAR_PROXY_DEBUG,
  escapeRegExp,
  restoreUrl,
  shouldLog,
} from "./lib";

declare const self: ServiceWorkerGlobalScope;

declare global {
  interface ServiceWorkerGlobalScope {
    proxy_target_protocol: string;
    proxy_target_host: string;
  }
}

const params = new URLSearchParams(location.search);

const proxy_url = params.get(VAR_PROXY_URL);
if (!proxy_url) {
  throw new Error("empty proxy_url");
}
const ProxyUrl = new URL(proxy_url);
const proxy_real_protocol = params.get(VAR_PROXY_REAL_PROTOCOL) || "";
const proxy_real_host = params.get(VAR_PROXY_REAL_HOST) || "";
const proxy_debug = params.get(VAR_PROXY_DEBUG) || "";

console.log("Service Worker", ProxyUrl.href, proxy_real_protocol, proxy_real_host);

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
  content = content.replace(new RegExp(escapeRegExp(ProxyUrl.href) + "(https?)(?:://|/)([^/]+)", "g"), "$1://$2");

  // 恢复被混淆的 JS 属性
  content = content.replace(/___location/g, "location");
  content = content.replace(/___URL/g, "URL");
  content = content.replace(/___domain/g, "domain");
  content = content.replace(/navigator.___serviceWorker/g, "navigator.serviceWorker");
  content = content.replace(/document.___requestStorageAccessFor/g, "document.requestStorageAccessFor");
  return content;
}

// --- Service Worker 消息监听 ---
self.addEventListener("message", (event) => {
  const data: ProxyMsg = event.data;
  if (data.type === "PROXY_CUR_LOCATION") {
    // 更新当前页面的目标协议和主机
    const { protocol, host } = data.data;
    if (protocol && host && (protocol !== self.proxy_target_protocol || host !== self.proxy_target_host)) {
      self.proxy_target_protocol = protocol;
      self.proxy_target_host = host;
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
  if (shouldLog(event.request.url, proxy_debug)) {
    console.log(">> sw fetch", event.request.url);
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
          if (shouldLog(event.request.url, proxy_debug)) {
            console.log("sw direct fetch", event.request.url);
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
          if (event.request.destination === FETCH_DEST_DOCUMENT) {
            if (shouldLog(event.request.url, proxy_debug)) {
              console.log("sw direct document fetch", event.request.url);
            }
            return fetch(event.request);
          }
          targetProtocol = self.proxy_target_protocol || proxy_real_protocol;
          targetHost = self.proxy_target_host || proxy_real_host;
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
      if (shouldLog(finalUrl, proxy_debug)) {
        console.log(`sw fetch requestUrlObj=${targetUrl}, proxy_url=${ProxyUrl}, finalUrl=${finalUrl}`);
      }
      const fetchOptions: RequestInit = {
        method: event.request.method,
        headers: requestHeaders,
        mode: "cors",
        credentials: "include", // 包含 Cookie
        redirect: event.request.redirect,
      };
      // --- 安全逻辑 2: 处理 POST/PUT 请求体 ---
      if ((WITH_REQUEST_BODY_METHODS as readonly string[]).includes(event.request.method.toUpperCase())) {
        const clonedRequest = event.request.clone();
        const contentType = clonedRequest.headers.get(HEADER_CONTENT_TYPE);
        const contentEncoding = clonedRequest.headers.get(HEADER_CONTENT_ENCODING);

        // 如果是文本类数据 (JSON/Text/Form) 且未被压缩
        if (
          !contentEncoding &&
          contentType &&
          (contentType.includes("json") || contentType.includes("text") || contentType.includes("form"))
        ) {
          let bodyText = await clonedRequest.text();
          // 重写 Body 里的 URL
          bodyText = rewriteUrlsInContent(bodyText);
          fetchOptions.body = bodyText;
        } else {
          // 二进制数据直接透传
          const bodyBuffer = await clonedRequest.arrayBuffer();
          fetchOptions.body = bodyBuffer;
        }

        // 发起请求
        const newRequest = new Request(finalUrl, fetchOptions);
        return fetch(newRequest);
      } else {
        // GET 等其他请求
        const newRequest = new Request(finalUrl, fetchOptions);
        return fetch(newRequest);
      }
    })()
  );
});
