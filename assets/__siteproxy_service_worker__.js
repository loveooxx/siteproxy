const params = new URLSearchParams(location.search);

const proxy_url = params.get("proxy_url");
const proxy_real_protocol = params.get("proxy_real_protocol");
const proxy_real_host = params.get("proxy_real_host");
const ProxyUrl = new URL(proxy_url);

console.log("Service Worker", ProxyUrl.href, proxy_real_protocol, proxy_real_host);

// --- 全局变量：URL 映射缓存 ---
var pathHostCache = {};

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
let rewriteUrlsInContent = (content) => {
  // 将 "/path_prefix/http/___" 格式的链接还原
  content = content.replace(new RegExp(ProxyUrl.href + "(http[s]?)/([^/]+)", "g"), "$1://$2");

  // 恢复被混淆的 JS 属性
  content = content.replace(/___location/g, "location");
  content = content.replace(/___URL/g, "URL");
  content = content.replace(/___domain/g, "domain");
  content = content.replace(/navigator.___serviceWorker/g, "navigator.serviceWorker");
  content = content.replace(/document.___requestStorageAccessFor/g, "document.requestStorageAccessFor");
  return content;
};

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
          requestUrlObj.pathname.startsWith("/__siteproxy_") ||
          requestUrlObj.pathname === ProxyUrl.pathname ||
          requestUrlObj.pathname === "/robots.txt"
        ) {
          return fetch(event.request);
        }
        if (
          requestUrlObj.pathname.startsWith(ProxyUrl.pathname + "http/") ||
          requestUrlObj.pathname.startsWith(ProxyUrl.pathname + "https/")
        ) {
          const newUrl = requestUrlObj.pathname.slice(ProxyUrl.pathname.length).replace("/", "://");
          requestUrlObj = new URL(newUrl);
          targetProtocol = requestUrlObj.protocol.slice(0, -1);
          targetHost = requestUrlObj.host;
        } else {
          targetProtocol = self.proxy_target_protocol || proxy_real_protocol;
          targetHost = self.proxy_target_host || proxy_real_host;
        }
      } else {
        targetProtocol = requestUrlObj.protocol.slice(0, -1);
        targetHost = requestUrlObj.host;
      }
      let targetReferer = targetProtocol + "://" + targetHost;
      let requestHeaders = new Headers(event.request.headers);

      if (requestHeaders.get("siteproxy-target-host")) {
        targetProtocol = requestHeaders.get("siteproxy-target-protocol");
        targetHost = requestHeaders.get("siteproxy-target-host");
        targetReferer = requestHeaders.get("siteproxy-real-referer");
      }
      requestHeaders.set("siteproxy-newreferer", targetReferer);
      const finalUrl = ProxyUrl.href + targetProtocol + "/" + targetHost + requestUrlObj.pathname + searchParams;
      // console.log(`requestUrlObj=${requestUrlObj}, proxy_url=${ProxyUrl}, finalUrl=${finalUrl}`);

      // 准备 Fetch 选项
      const fetchOptions = {
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
