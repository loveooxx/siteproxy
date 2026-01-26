import {
  PREFIX,
  HEADER_SITEPROXY_NEWREFERER,
  HEADER_SITEPROXY_REAL_REFERER,
  HEADER_SITEPROXY_TARGET_HOST,
  HEADER_SITEPROXY_TARGET_PROTOCOL,
  Marks,
  markProto,
  escapeRegExp,
} from "./lib";

declare var self: ServiceWorkerGlobalScope;

declare global {
  interface ServiceWorkerGlobalScope {
    proxy_target_protocol: string;
    proxy_target_host: string;
  }
}

const params = new URLSearchParams(location.search);

const proxy_url = params.get("proxy_url");
if (!proxy_url) {
  throw new Error("empty proxy_url");
}
const ProxyUrl = new URL(proxy_url);
const proxy_real_protocol = params.get("proxy_real_protocol") || "";
const proxy_real_host = params.get("proxy_real_host") || "";

console.log("Service Worker", ProxyUrl.href, proxy_real_protocol, proxy_real_host);

// --- 全局变量：URL 映射缓存 ---
const pathHostCache: Record<string, any> = {};

// --- 定时任务：清理过期的缓存 ---
function cleanCache() {
  const now = Date.now();
  for (let path in pathHostCache) {
    if (now > pathHostCache[path].lasttime + 30000) {
      // 30秒过期
      delete pathHostCache[path];
    }
  }
}
setInterval(cleanCache, 2000);

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
  if (event.data.type === "PROXY_CUR_LOCATION") {
    // 更新当前页面的目标协议和主机
    const { protocol, host } = event.data.data;
    if (protocol && host && (protocol !== self.proxy_target_protocol || host !== self.proxy_target_host)) {
      self.proxy_target_protocol = protocol;
      self.proxy_target_host = host;
    }
  } else if (event.data.type === "PROXY_URL_HOST_MAP") {
    // 缓存特定路径对应的真实主机信息
    pathHostCache[event.data.data.pathname] = {
      real_protocol: event.data.data.real_protocol,
      real_host: event.data.data.real_host,
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
  event.respondWith(
    (async () => {
      let requestUrlObj = new URL(event.request.url);

      let targetProtocol = "";
      let targetHost = "";
      let searchParams = rewriteUrlsInContent(requestUrlObj.search);

      if (requestUrlObj.origin === location.origin) {
        if (
          requestUrlObj.pathname.startsWith("/" + PREFIX) ||
          requestUrlObj.pathname.startsWith(ProxyUrl.pathname + PREFIX) ||
          requestUrlObj.pathname === ProxyUrl.pathname ||
          requestUrlObj.pathname === "/robots.txt"
        ) {
          return fetch(event.request);
        }
        let found = false;
        for (const mark of Marks) {
          if (requestUrlObj.pathname.startsWith(ProxyUrl.pathname + mark)) {
            const newUrl =
              markProto(mark) + "://" + requestUrlObj.pathname.slice(ProxyUrl.pathname.length + mark.length);
            requestUrlObj = new URL(newUrl);
            targetProtocol = requestUrlObj.protocol.slice(0, -1);
            targetHost = requestUrlObj.host;
            found = true;
            break;
          }
        }
        if (!found) {
          targetProtocol = self.proxy_target_protocol || proxy_real_protocol;
          targetHost = self.proxy_target_host || proxy_real_host;
        }
      } else {
        targetProtocol = requestUrlObj.protocol.slice(0, -1);
        targetHost = requestUrlObj.host;
      }
      let targetReferer = targetProtocol + "://" + targetHost;
      let requestHeaders = new Headers(event.request.headers);

      if (requestHeaders.get(HEADER_SITEPROXY_TARGET_HOST)) {
        targetProtocol = requestHeaders.get(HEADER_SITEPROXY_TARGET_PROTOCOL) || "";
        targetHost = requestHeaders.get(HEADER_SITEPROXY_TARGET_HOST) || "";
        targetReferer = requestHeaders.get(HEADER_SITEPROXY_REAL_REFERER) || "";
      }
      requestHeaders.set(HEADER_SITEPROXY_NEWREFERER, targetReferer);
      const finalUrl = ProxyUrl.href + targetProtocol + "/" + targetHost + requestUrlObj.pathname + searchParams;
      // console.log(`requestUrlObj=${requestUrlObj}, proxy_url=${ProxyUrl}, finalUrl=${finalUrl}`);

      // 准备 Fetch 选项
      const fetchOptions: RequestInit = {
        method: event.request.method,
        headers: requestHeaders,
        mode: "cors",
        credentials: "include", // 包含 Cookie
        redirect: event.request.redirect,
      };

      // --- 安全逻辑 2: 处理 POST/PUT 请求体 ---
      if (["POST", "PUT", "PATCH"].includes(event.request.method.toUpperCase())) {
        const clonedRequest = event.request.clone();
        const contentType = clonedRequest.headers.get("Content-Type");
        const contentEncoding = clonedRequest.headers.get("Content-Encoding");

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
          let bodyBuffer = await clonedRequest.arrayBuffer();
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
