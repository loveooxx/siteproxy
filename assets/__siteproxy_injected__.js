/**
 * SiteProxy Client Side Injection Script (Deobfuscated)
 * * 功能：
 * 1. 劫持 window.open, History API, fetch, XHR。
 * 2. 模拟 window.location (LocationProxy)，欺骗页面脚本认为在原站运行。
 * 3. 使用 MutationObserver 监听 DOM 变化，自动重写新插入元素的 src/href 属性。
 * 4. 注册 Service Worker 以拦截更多请求。
 * 5. 显示顶部栏。
 */

(function () {
  if (window.__SITEPROXY_INJECTED__) {
    return;
  }
  const ProxyUrl = new URL(window.__SITEPROXY_PROXY_URL__);
  const ProxyRealProtocol = window.__SITEPROXY_REAL_PROTOCOL__;
  const ProxyRealHost = window.__SITEPROXY_REAL_HOST__;
  const HideHeader = !!window.__SITEPROXY_HIDE_HEADER__;

  window.__SITEPROXY_INJECTED__ = true;

  // 备份原始 URL 对象
  window.___URL = window.URL;

  // ==========================================
  // 1. 劫持 window.open
  // ==========================================
  var originalWindowOpen = window.open;
  window.open = function (url, target, features) {
    // 在打开新窗口前，将 URL 转换为代理 URL
    let proxiedUrl = addProxyPrefix(url);
    return originalWindowOpen.call(window, proxiedUrl, target, features);
  };

  // ==========================================
  // 2. 劫持 History API (pushState, replaceState)
  // ==========================================
  var originalPushState = History.prototype.pushState;
  var originalReplaceState = History.prototype.replaceState;

  History.prototype.___pushState = function (state, title, url) {
    const proxiedUrl = addProxyPrefix(url);
    return originalPushState.apply(this, [state, title, proxiedUrl]);
  };

  History.prototype.___replaceState = function (state, title, url) {
    const proxiedUrl = addProxyPrefix(url);
    return originalReplaceState.apply(this, [state, title, proxiedUrl]);
  };

  // ==========================================
  // 3. 劫持 document.URL 和 document.domain
  // ==========================================
  Object.defineProperty(document, "___URL", {
    get: function () {
      // 返回去除代理前缀后的真实 URL
      return removeProxyPrefix(document.URL);
    },
    set: function (url) {
      // 设置时自动添加代理前缀
      let proxiedUrl = addProxyPrefix(url);
      document.URL = proxiedUrl;
    },
  });

  Object.defineProperty(document, "___domain", {
    get: function () {
      return getHostFromProxyPrefixedURL(document.URL);
    },
    set: function (val) {},
  });

  // ==========================================
  // 4. LocationProxy 类 (模拟 window.location)
  // ==========================================
  class LocationProxy {
    constructor(realLocation) {
      this.originalLocation = realLocation;
    }

    toString() {
      return removeProxyPrefix(this.originalLocation.href);
    }

    assign(url) {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.assign(proxiedUrl);
    }

    reload(forceGet = false) {
      this.originalLocation.reload(forceGet);
    }

    replace(url) {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.replace(proxiedUrl);
    }

    get href() {
      return removeProxyPrefix(this.originalLocation.href);
    }
    set href(url) {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.href = proxiedUrl;
    }

    get origin() {
      // 返回真实站点的 origin，例如 https://www.google.com
      return ProxyRealProtocol + "://" + ProxyRealHost;
    }

    get protocol() {
      return getProtocolFromProxyPrefixedURL(this.originalLocation.href) + ":";
    }
    set protocol(val) {
      const newUrl = setProtocolFromProxyPrefixedURL(this.originalLocation.href, val);
      this.originalLocation.href = newUrl;
    }

    get pathname() {
      return getPathnameFromProxyPrefixedURL(this.originalLocation.href);
    }
    set pathname(val) {
      // 简化处理，暂未实现 setter 逻辑
    }

    get host() {
      return getHostFromProxyPrefixedURL(this.originalLocation.href);
    }
    set host(val) {}

    get search() {
      return this.originalLocation.search;
    }
    set search(val) {}

    get hash() {
      return this.originalLocation.hash;
    }
    set hash(val) {
      this.originalLocation.hash = val;
    }

    get hostname() {
      let host = getHostFromProxyPrefixedURL(this.originalLocation.href);
      const colonIndex = host.indexOf(":");
      if (colonIndex !== -1) {
        host = host.substring(0, colonIndex);
      }
      return host;
    }
    set hostname(val) {}

    get port() {
      const host = getHostFromProxyPrefixedURL(this.originalLocation.href);
      const colonIndex = host.indexOf(":");
      let port = "";
      if (colonIndex !== -1) {
        port = host.substring(colonIndex + 1);
      }
      return port;
    }
    set port(val) {}
  }

  // 初始化 LocationProxy 并覆盖 window.___location
  (function () {
    let locationProxyInstance = new LocationProxy(window.location);
    window.___location = locationProxyInstance;
    document.___location = window.___location;

    Object.defineProperty(window, "___location", {
      set: function (url) {
        locationProxyInstance.href = url;
      },
      get: function () {
        return locationProxyInstance;
      },
      configurable: true,
    });

    Object.defineProperty(document, "___location", {
      set: function (url) {
        locationProxyInstance.href = url;
      },
      get: function () {
        return locationProxyInstance;
      },
      configurable: true,
    });
  })();

  // ==========================================
  // 5. URL 处理核心函数
  // ==========================================

  // 构建用于请求头的 Referer 或辅助 URL
  function constructProxyHelperUrl(url, realProtocol, realHost) {
    if (url.startsWith(ProxyUrl.origin)) {
      url = url.substring(ProxyUrl.origin.length);
      if (url.startsWith(ProxyUrl.pathname)) {
        url = url.substring(ProxyUrl.pathname.length);
      }
      if (url.startsWith("https/")) {
        return "https://" + url.substring(6);
      } else if (url.startsWith("http/")) {
        return "http://" + url.substring(5);
      } else {
        return realProtocol + "://" + realHost + url;
      }
    }
    return url;
  }

  // 劫持 postMessage (用于 iframe 通信)
  var originalPostMessage = window.postMessage.bind(window);
  window.postMessage = function (message, targetOrigin, transfer) {
    // 强制 targetOrigin 为 *，避免跨域限制（因为我们在代理域下）
    originalPostMessage(message, "*", transfer);
  };

  // ==========================================
  // 6. 劫持 Fetch 和 XMLHttpRequest
  // ==========================================
  var originalFetch = window.fetch;
  window.fetch = async (...args) => {
    // 注入自定义 Header，告诉代理服务器真实的目标协议和主机
    if (args[0] instanceof Request) {
      const req = args[0];
      let headers = new Headers(req.headers);
      headers.set("siteproxy-target-protocol", ProxyRealProtocol);
      headers.set("siteproxy-target-host", ProxyRealHost);

      const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
      headers.set("siteproxy-real-referer", realReferer);
      headers.set("siteproxy-window-location-pathname", window.___location.pathname);

      args[0] = new Request(req, { headers: headers });
    } else {
      let options = args[1] || {};
      options.headers = new Headers(options.headers || {});
      options.headers.set("siteproxy-target-protocol", ProxyRealProtocol);
      options.headers.set("siteproxy-target-host", ProxyRealHost);

      const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
      options.headers.set("siteproxy-real-referer", realReferer);
      options.headers.set("siteproxy-window-location-pathname", window.___location.pathname);
      args[1] = options;
    }
    return originalFetch(...args);
  };

  var originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = async function (method, url, ...rest) {
    originalXHROpen.call(this, method, url, ...rest);
    this.setRequestHeader("siteproxy-target-protocol", ProxyRealProtocol);
    this.setRequestHeader("siteproxy-target-host", ProxyRealHost);
    const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
    this.setRequestHeader("siteproxy-real-referer", realReferer);
    this.setRequestHeader("siteproxy-window-location-pathname", window.___location.pathname);
  };

  // ==========================================
  // 7. 辅助解析函数 (从代理 URL 提取信息)
  // ==========================================

  function getPathnameFromProxyPrefixedURL(url) {
    if (!url || !url.startsWith(ProxyUrl)) return "";
    let urlObj;
    url = url.substring(ProxyUrl.length);
    if (url.startsWith("https/")) {
      urlObj = new URL("https://" + url.substring(6));
    } else if (url.startsWith("http/")) {
      urlObj = new URL("http://" + url.substring(5));
    }
    if (urlObj) return urlObj.pathname;
    return "";
  }

  function getHostFromProxyPrefixedURL(url) {
    if (!url || !url.startsWith(ProxyUrl)) return "";
    let urlObj;
    url = url.substring(ProxyUrl.length);
    if (url.startsWith("https/")) {
      urlObj = new URL("https://" + url.substring(6));
    } else if (url.startsWith("http/")) {
      urlObj = new URL("http://" + url.substring(5));
    }
    if (urlObj) return urlObj.host;
    return "";
  }

  function setProtocolFromProxyPrefixedURL(currentUrl, newProtocol) {
    if (!newProtocol || !currentUrl || !currentUrl.startsWith(ProxyUrl)) return currentUrl;

    // 替换 https/ 为 http/ 或反之
    if (currentUrl.substring(ProxyUrl.length).startsWith("https/")) {
      // 原来是 https
      currentUrl =
        currentUrl.substring(0, ProxyUrl.length) + newProtocol + "/" + currentUrl.substring(ProxyUrl.length + 6);
    } else {
      // 原来是 http
      currentUrl =
        currentUrl.substring(0, ProxyUrl.length) + newProtocol + "/" + currentUrl.substring(ProxyUrl.length + 5);
    }
    return currentUrl;
  }

  function getProtocolFromProxyPrefixedURL(url) {
    if (!url || !url.startsWith(ProxyUrl)) return "";
    url = url.substring(ProxyUrl.length);
    if (url.startsWith("https/")) return "https";
    if (url.startsWith("http/")) return "http";
    return "";
  }

  // 核心函数：移除代理前缀，还原真实 URL
  function removeProxyPrefix(url) {
    if (!url || !url.startsWith(ProxyUrl.origin)) return url;

    // 去掉 Proxy URL (如 http://localhost:5006)
    let relativePath = url.substring(ProxyUrl.origin.length);
    if (relativePath.startsWith("/")) relativePath = relativePath.substring(1);

    // 去掉 Token (如 /user123/)
    let token = ProxyUrl.pathname.slice(1);
    if (relativePath.startsWith(token)) {
      relativePath = relativePath.substring(token.length);
    }

    // 还原协议
    if (relativePath.startsWith("https/")) {
      return "https://" + relativePath.substring(6);
    } else if (relativePath.startsWith("http/")) {
      return "http://" + relativePath.substring(5);
    } else {
      // 如果没有协议前缀，假设是当前页面的协议和主机
      return ProxyRealProtocol + "://" + ProxyRealHost + "/" + relativePath;
    }
  }

  // 核心函数：添加代理前缀 (将真实 URL 转换为代理 URL)
  function addProxyPrefix(url) {
    if (!url || url.startsWith(ProxyUrl)) {
      return url;
    }

    // 忽略特殊协议
    if (
      url.startsWith("blob:") ||
      url.startsWith("javascript:") ||
      url.startsWith("mailto:") ||
      url.startsWith("#") ||
      url.startsWith("about:") ||
      url.startsWith("chrome:") ||
      url.startsWith("data:") ||
      url.startsWith("ftp:") ||
      url.startsWith("file:") ||
      url.startsWith("tel:") ||
      url.startsWith("sms:") ||
      url.startsWith("view-source:") ||
      url.startsWith("webcal:") ||
      url.startsWith("content:") ||
      url.startsWith("ssh:") ||
      url.startsWith("vbscript:")
    ) {
      return url;
    }

    // 如果已经是代理的基础 URL 开头，去掉它只保留路径
    if (url.startsWith(ProxyUrl.origin)) {
      url = url.substring(ProxyUrl.origin.length);
    }

    // 处理字符串中的绝对路径 http://...
    // 修改说明：
    // 1. 正则修正为 ([^\\s"']+) 表示匹配非空白、非引号的字符，这样能匹配完整 URL
    // 2. 回调函数修正，使用 hostPart (第三个捕获组) 而不是 rest (offset)
    const regexMap = { "()(https?://|//)([^\\s\"']+)": "" };
    for (let regexStr in regexMap) {
      let regex = new RegExp(regexStr, "gi");
      url = url.replace(regex, (match, p1, protocolPart, hostPart, offset, string) => {
        let protocol;
        if (protocolPart === "//") {
          protocol = "https"; // 默认 // 为 https
        } else {
          protocol = protocolPart.replace("://", "").toLowerCase();
        }
        // 这里必须使用 hostPart (URL的剩余部分)，不能使用 offset
        return ProxyUrl + protocol + "/" + hostPart;
      });
    }

    // 再次清理可能重复的前缀
    let proxyBase = ProxyUrl.origin.substring(ProxyUrl.origin.indexOf("//"));
    if (url.startsWith(proxyBase)) {
      url = url.substring(proxyBase.length);
    }

    // 构建完整代理 URL
    let defaultProxyBase = ProxyUrl + ProxyRealProtocol + "/" + ProxyRealHost;
    let prefix = ProxyUrl;

    if (url.startsWith("//")) {
      url = prefix + "/https/" + url.slice(2);
      url = url.replace("//https", "/https");
    } else if (url.startsWith("/")) {
      url = defaultProxyBase + url;
    }
    return url;
  }

  // ==========================================
  // 8. DOM 监听与自动 URL 重写 (MutationObserver)
  // ==========================================
  var monitoredAttributes = ["src", "href", "action", "data-url", "srcset"];
  var observerConfig = {
    attributes: true,
    childList: true,
    subtree: true,
    attributeOldValue: true,
    characterDataOldValue: true,
    attributeFilter: monitoredAttributes,
  };

  // MutationObserver 回调
  async function handleMutationCallback(mutations, observer) {
    observer.disconnect(); // 暂停监听以避免死循环
    mutations.forEach((mutation) => {
      switch (mutation.type) {
        case "attributes":
          let attrValue = mutation.target.getAttribute(mutation.attributeName);
          if (monitoredAttributes.includes(mutation.attributeName)) {
            let proxiedValue = addProxyPrefix(attrValue);

            // 移除 integrity 属性，因为代理可能修改了内容导致哈希不匹配
            if (mutation.target.tagName.toLowerCase() === "script" && mutation.target.hasAttribute("integrity")) {
              mutation.target.removeAttribute("integrity");
            }

            if (proxiedValue !== attrValue) {
              mutation.target.setAttribute(mutation.attributeName, proxiedValue);
            }
          }
          break;
        case "childList":
          mutation.addedNodes.forEach((node) => {
            traverseAndRewriteNode(node);
          });
          break;
      }
    });
    observer.observe(document.documentElement, observerConfig);
  }

  // 递归遍历节点并重写属性
  function traverseAndRewriteNode(node) {
    if (node._traversed) return;
    node._traversed = true;

    node.childNodes.forEach((child) => {
      traverseAndRewriteNode(child);
    });

    if (node.nodeType === Node.ELEMENT_NODE) {
      monitoredAttributes.forEach((attr) => {
        if (node.hasAttribute(attr)) {
          let val = node.getAttribute(attr);
          let proxiedVal = addProxyPrefix(val);

          if (node.tagName.toLowerCase() === "script" && node.hasAttribute("integrity")) {
            node.removeAttribute("integrity");
          }

          if (proxiedVal !== val) {
            node.setAttribute(attr, proxiedVal);
          }
        }
      });

      // 特殊处理 iframe
      if (node.tagName.toLowerCase() === "iframe" && !node._loadListenerAdded) {
        node._loadListenerAdded = true;
        node.addEventListener("load", function () {
          if (node.contentDocument && !node.contentDocument._observerSet) {
            node.contentDocument._observerSet = true;
            traverseAndRewriteNode(node.contentDocument);
            let iframeObserver = new MutationObserver(handleMutationCallback);
            iframeObserver.observe(node.contentDocument.documentElement, observerConfig);
          }
        });
      }

      // 直接处理 iframe 内容（如果同源且可访问）
      if (node.tagName.toLowerCase() === "iframe") {
        const doc = node.contentDocument;
        if (doc && !doc._observerSet) {
          doc._observerSet = true;
          traverseAndRewriteNode(doc);
          let iframeObserver = new MutationObserver(handleMutationCallback);
          iframeObserver.observe(doc.documentElement, observerConfig);
        }
      }
    }
  }

  // ==========================================
  // 显示顶部导航栏 (Address Bar)
  // ==========================================
  function showHeader() {
    // 如果用户在这个会话中已经关闭过，就不再显示
    if (HideHeader || sessionStorage.getItem("siteproxy_navbar_hidden")) {
      return;
    }

    var barHeight = "40px";
    var bar = document.createElement("div");
    bar.id = "siteproxy-navbar-container";

    // 设置导航条样式
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: barHeight,
      backgroundColor: "#333333",
      borderBottom: "1px solid #000",
      zIndex: "2147483647", // 保证在最顶层
      display: "flex",
      alignItems: "center",
      padding: "0 10px",
      boxSizing: "border-box",
      fontFamily: "Arial, sans-serif",
      boxShadow: "0 2px 5px rgba(0,0,0,0.3)",
    });

    // 创建表单容器
    var form = document.createElement("form");
    Object.assign(form.style, {
      display: "flex",
      width: "100%",
      margin: "0",
    });

    // 2. Submit (Go) 按钮
    var hpBtn = document.createElement("button");
    hpBtn.innerText = "Home";
    Object.assign(hpBtn.style, {
      height: "30px",
      padding: "0 15px",
      border: "1px solid #555",
      borderLeft: "none",
      borderRadius: "0 3px 3px 0",
      backgroundColor: "#4CAF50",
      color: "white",
      cursor: "pointer",
      fontWeight: "bold",
      fontSize: "13px",
    });
    hpBtn.onclick = function (e) {
      e.preventDefault();
      location.href = ProxyUrl.pathname;
    };

    // 1. URL 输入框
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter URL...";
    // 使用我们之前劫持的 window.___location.href 获取真实 URL
    input.value = window.___location ? window.___location.href : removeProxyPrefix(window.location.href);

    Object.assign(input.style, {
      flex: "1",
      height: "28px",
      padding: "0 8px",
      border: "1px solid #555",
      borderRadius: "3px 0 0 3px",
      outline: "none",
      backgroundColor: "#222",
      color: "#fff",
      fontSize: "14px",
    });

    // 输入框聚焦时全选
    input.onfocus = function () {
      this.select();
    };

    // 2. Submit (Go) 按钮
    var submitBtn = document.createElement("button");
    submitBtn.innerText = "Go";
    Object.assign(submitBtn.style, {
      height: "30px",
      padding: "0 15px",
      border: "1px solid #555",
      borderLeft: "none",
      borderRadius: "0 3px 3px 0",
      backgroundColor: "#4CAF50",
      color: "white",
      cursor: "pointer",
      fontWeight: "bold",
      fontSize: "13px",
    });

    // 鼠标悬停效果
    submitBtn.onmouseover = function () {
      this.style.backgroundColor = "#45a049";
    };
    submitBtn.onmouseout = function () {
      this.style.backgroundColor = "#4CAF50";
    };

    // 3. 关闭 (X) 按钮
    var closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Close Navigation Bar";
    Object.assign(closeBtn.style, {
      marginLeft: "10px",
      background: "transparent",
      border: "none",
      color: "#aaa",
      fontSize: "24px",
      cursor: "pointer",
      lineHeight: "30px",
      padding: "0 5px",
    });
    closeBtn.onmouseover = function () {
      this.style.color = "#fff";
    };
    closeBtn.onmouseout = function () {
      this.style.color = "#aaa";
    };

    // --- 事件处理 ---

    // 提交表单：跳转到新地址
    form.onsubmit = function (e) {
      e.preventDefault();
      var targetUrl = input.value.trim();
      if (!targetUrl) return;

      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        // 简单的判断：如果看起来像域名，默认 https
        targetUrl = "https://" + targetUrl;
      }

      // 使用 injected.js 现有的 addProxyPrefix 函数将真实 URL 转为代理 URL
      // 注意：直接修改 window.location.href 会触发浏览器跳转
      window.location.href = addProxyPrefix(targetUrl);
    };

    // 关闭导航条
    closeBtn.onclick = function (e) {
      e.preventDefault(); // 防止触发表单提交
      bar.style.display = "none";
      document.body.style.marginTop = "0";
      // 记录到 sessionStorage，本次会话不再显示（根据需求可启用）
      sessionStorage.setItem("siteproxy_navbar_hidden", "true");
    };

    // --- 组装 DOM ---
    form.appendChild(hpBtn);
    form.appendChild(input);
    form.appendChild(submitBtn);
    bar.appendChild(form);
    bar.appendChild(closeBtn);

    // 插入到页面顶部
    if (document.body) {
      document.body.insertBefore(bar, document.body.firstChild);
      // 将页面内容下推，防止导航条遮挡网页顶部内容
      document.body.style.marginTop = barHeight;
    }
  }

  // 启动 MutationObserver
  var mainObserver = new MutationObserver(handleMutationCallback);
  mainObserver.observe(document.documentElement, observerConfig);

  // DOMContentLoaded 事件
  document.addEventListener("DOMContentLoaded", () => {
    traverseAndRewriteNode(document.documentElement);
    showHeader();

    // 定期检查和修正 URL (针对非 jsdom 环境)
    if (typeof navigator === "object" && !navigator.userAgent.includes("jsdom")) {
      setTimeout(ensureTrailingSlash, 2000);
    }
  });

  // ==========================================
  // 10. Service Worker 注册与通信
  // ==========================================

  // 向 Service Worker 发送 URL 映射信息
  function notifySWUrlMap(pathname, realProtocol, realHost) {
    if (window.proxy_worker_registration && window.proxy_worker_registration.active) {
      window.proxy_worker_registration.active.postMessage({
        type: "PROXY_URL_HOST_MAP",
        data: {
          pathname: pathname,
          real_protocol: realProtocol,
          real_host: realHost,
        },
      });
    }
  }

  // 向 Service Worker 发送当前代理状态
  function notifySWCurrentLocation() {
    if (!ProxyRealProtocol || window.self !== window.top) {
      return;
    }
    if (window.proxy_worker_registration && window.proxy_worker_registration.active) {
      window.proxy_worker_registration.active.postMessage({
        type: "PROXY_CUR_LOCATION",
        data: {
          protocol: ProxyRealProtocol,
          host: ProxyRealHost,
        },
      });
    }
  }

  // 注册 Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      // 检查是否已经注册了 siteproxy worker
      var isRegistered = registrations.some(function (reg) {
        let isActive = reg.active && reg.active.scriptURL.includes("__siteproxy_service_worker__.js");
        if (isActive) {
          console.log("!!! proxy service worker already registered.");
          window.proxy_worker_registration = reg;
          notifySWCurrentLocation();
        }
        return isActive;
      });

      if (!isRegistered) {
        window.addEventListener("load", function () {
          if (window.proxy_worker_registration && window.proxy_worker_registration.active) {
            return;
          }
          // 注册新的 SW，携带当前真实协议和主机
          navigator.serviceWorker
            .register(
              `/__siteproxy_service_worker__.js?${new URLSearchParams({
                proxy_url: ProxyUrl,
                proxy_real_protocol: ProxyRealProtocol,
                proxy_real_host: ProxyRealHost,
              }).toString()}`
            )
            .then(
              function (reg) {
                console.log(
                  `siteproxy_service_worker registered. ` +
                    `scope=${reg.scope}, protocol=${ProxyRealProtocol}, host=${ProxyRealHost}`
                );
                window.proxy_worker_registration = reg;
                notifySWCurrentLocation();
              },
              function (err) {
                console.log("siteproxy_service_worker registration failed: ", err);
              }
            );
        });
      }
    });
  }

  // ==========================================
  // 11. 特殊站点处理 (GitHub & YouTube)
  // ==========================================

  // Github 表单提交修复
  if (window.location.pathname.includes("github.com")) {
    setTimeout(() => {
      document.querySelector("form").addEventListener("submit", function (e) {
        e.preventDefault();
        const action = e.target.action;
        const method = e.target.method || "POST";
        const formData = new FormData(e.target);

        // 手动 Fetch 提交
        fetch(action, {
          method: method,
          body: formData,
          headers: {},
        })
          .then((res) => {
            window.location.href = res.url;
          })
          .catch((err) => {
            console.error("Error in form submission fetch", err);
          });
      });
    }, 4000);
  }

  // 确保根路径有尾随斜杠
  function ensureTrailingSlash() {
    const path = window.___location.pathname;
    const search = window.___location.search;
    const hash = window.___location.hash;
    const href = window.___location.href;
    if (window.self === window.top && path === "/" && search === "" && hash === "" && !href.endsWith("/")) {
      let newHref = href + "/";
      window.___location.href = newHref;
    }
  }

  // 暴露全局变量 (调试或 SW 使用)
  window.siteproxyAttributeChanged = handleMutationCallback;
  window.removeProxyPrefix = removeProxyPrefix;
  window.setProtocolFromProxyPrefixedURL = setProtocolFromProxyPrefixedURL;
  window.traverseAndModifyNode = traverseAndRewriteNode;
  window.siteproxyRegReplacement = addProxyPrefix;
})();
