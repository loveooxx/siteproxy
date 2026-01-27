/**
 * SiteProxy Client Side Injection Script.
 * * 功能：
 * 1. 劫持 window.open, History API, fetch, XHR。
 * 2. 模拟 window.location (LocationProxy)，欺骗页面脚本认为在原站运行。
 * 3. 使用 MutationObserver 监听 DOM 变化，自动重写新插入元素的 src/href 属性。
 * 4. 注册 Service Worker 以拦截更多请求。
 * 5. 显示顶部栏。
 */

import {
  type ProxyCurLocationMsg,
  type ProxyUrlHostMapMsg,
  PREFIX,
  METHOD_POST,
  HEADER_SITEPROXY_REAL_REFERER,
  HEADER_SITEPROXY_TARGET_HOST,
  HEADER_SITEPROXY_TARGET_PROTOCOL,
  HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME,
  VAR_PROXY_URL,
  VAR_PROXY_REAL_PROTOCOL,
  VAR_PROXY_REAL_HOST,
  VAR_PROXY_DEBUG,
  Marks,
  markProto,
  restoreUrl,
  fixInputUrl,
  str2int,
  isBaseOrSubHost,
} from "./lib";

// ==========================================
// 1. Type Definitions & Global Augmentation
// ==========================================

declare global {
  interface Window {
    __SITEPROXY_INJECTED?: boolean;
    __SITEPROXY_PROXY_URL: string;
    __SITEPROXY_REAL_PROTOCOL: string;
    __SITEPROXY_REAL_HOST: string;
    __SITEPROXY_HIDE_TOP: string;
    __SITEPROXY_DEBUG: string;
    ___URL: typeof window.URL;
    ___location: any;

    // Service Worker Registration storage
    proxy_worker_registration?: ServiceWorkerRegistration;
  }

  interface Document {
    ___URL: string;
    ___domain: string;
    ___location: any;
    // Internal marker for iframes
    _observerSet?: boolean;
  }

  interface History {
    ___pushState(data: any, unused: string, url?: string | URL | null): void;
    ___replaceState(data: any, unused: string, url?: string | URL | null): void;
  }

  // Extending Node to handle the internal flags added by the script
  interface Node {
    _traversed?: boolean;
    _loadListenerAdded?: boolean;
  }
}

// ==========================================
// 2. Main Execution
// ==========================================

(function () {
  if (window.__SITEPROXY_INJECTED) {
    return;
  }

  const ProxyUrl = new URL(window.__SITEPROXY_PROXY_URL);
  const ProxyRealProtocol = window.__SITEPROXY_REAL_PROTOCOL;
  const ProxyRealHost = window.__SITEPROXY_REAL_HOST;
  const HIDE_TOP = !!str2int(window.__SITEPROXY_HIDE_TOP);
  const DEBUG = window.__SITEPROXY_DEBUG;

  window.__SITEPROXY_INJECTED = true;

  // Backup original URL object
  window.___URL = window.URL;

  // ==========================================
  // 1. Hijack window.open
  // ==========================================
  const originalWindowOpen = window.open;
  window.open = function (url?: string | URL, target?: string, features?: string): WindowProxy | null {
    // Convert URL to proxy URL before opening
    const urlString = url ? url.toString() : "";
    const proxiedUrl = addProxyPrefix(urlString);
    return originalWindowOpen.call(window, proxiedUrl, target, features);
  };

  // ==========================================
  // 2. Hijack History API (pushState, replaceState)
  // ==========================================
  const originalPushState = History.prototype.pushState;
  const originalReplaceState = History.prototype.replaceState;

  History.prototype.___pushState = function (state: any, title: string, url?: string | URL | null) {
    const proxiedUrl = url ? addProxyPrefix(url.toString()) : url;
    return originalPushState.apply(this, [state, title, proxiedUrl]);
  };

  History.prototype.___replaceState = function (state: any, title: string, url?: string | URL | null) {
    const proxiedUrl = url ? addProxyPrefix(url.toString()) : url;
    return originalReplaceState.apply(this, [state, title, proxiedUrl]);
  };

  // ==========================================
  // 3. Hijack document.URL and document.domain
  // ==========================================
  Object.defineProperty(document, "___URL", {
    get: function (): string {
      // Return real URL without proxy prefix
      return removeProxyPrefix(document.URL);
    },
    set: function (url: string) {
      // Add proxy prefix when setting
      const proxiedUrl = addProxyPrefix(url);
      // document.URL is read-only in standard DOM, this might not work in strict envs
      // but mimics the original script's intent.
      // We use type assertion to bypass TS readonly check here if strictly needed,
      // though typically document.URL cannot be set.
      // (document as any).URL = proxiedUrl;
    },
  });

  Object.defineProperty(document, "___domain", {
    get: function (): string {
      return getHostFromProxyPrefixedURL(document.URL);
    },
    set: function (val: string) {},
  });

  // ==========================================
  // 4. LocationProxy Class (Simulates window.location)
  // ==========================================
  class LocationProxy {
    private originalLocation: Location;

    constructor(realLocation: Location) {
      this.originalLocation = realLocation;
    }

    toString(): string {
      return removeProxyPrefix(this.originalLocation.href);
    }

    assign(url: string): void {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.assign(proxiedUrl);
    }

    reload(forceGet: boolean = false): void {
      this.originalLocation.reload(); // TS Definition doesn't always support forceGet argument in newer standards, but browsers do.
    }

    replace(url: string): void {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.replace(proxiedUrl);
    }

    get href(): string {
      return removeProxyPrefix(this.originalLocation.href);
    }
    set href(url: string) {
      const proxiedUrl = addProxyPrefix(url);
      this.originalLocation.href = proxiedUrl;
    }

    get origin(): string {
      // Return real site origin, e.g., https://www.google.com
      return ProxyRealProtocol + "://" + ProxyRealHost;
    }

    get protocol(): string {
      return getProtocolFromProxyPrefixedURL(this.originalLocation.href) + ":";
    }
    set protocol(val: string) {
      const newUrl = setProtocolFromProxyPrefixedURL(this.originalLocation.href, val);
      this.originalLocation.href = newUrl;
    }

    get pathname(): string {
      return getPathnameFromProxyPrefixedURL(this.originalLocation.href);
    }
    set pathname(val: string) {
      // Logic not implemented in original script
    }

    get host(): string {
      return getHostFromProxyPrefixedURL(this.originalLocation.href);
    }
    set host(val: string) {}

    get search(): string {
      return this.originalLocation.search;
    }
    set search(val: string) {}

    get hash(): string {
      return this.originalLocation.hash;
    }
    set hash(val: string) {
      this.originalLocation.hash = val;
    }

    get hostname(): string {
      const host = getHostFromProxyPrefixedURL(this.originalLocation.href);
      const i = host.indexOf(":");
      return i !== -1 ? host.slice(0, i) : host;
    }
    set hostname(val: string) {}

    get port(): string {
      const host = getHostFromProxyPrefixedURL(this.originalLocation.href);
      const i = host.indexOf(":");
      return i !== -1 ? host.slice(i + 1) : "";
    }
    set port(val: string) {}
  }

  // Initialize LocationProxy and overwrite window.___location
  (function () {
    const locationProxyInstance = new LocationProxy(window.location);
    window.___location = locationProxyInstance;
    document.___location = window.___location;

    Object.defineProperty(window, "___location", {
      set: function (url: string) {
        locationProxyInstance.href = url;
      },
      get: function () {
        return locationProxyInstance;
      },
      configurable: true,
    });

    Object.defineProperty(document, "___location", {
      set: function (url: string) {
        locationProxyInstance.href = url;
      },
      get: function () {
        return locationProxyInstance;
      },
      configurable: true,
    });
  })();

  // ==========================================
  // 5. URL Processing Core Functions
  // ==========================================

  // Construct Referer or helper URL for request headers
  function constructProxyHelperUrl(url: string, realProtocol: string, realHost: string): string {
    if (url.startsWith(ProxyUrl.origin)) {
      url = url.slice(ProxyUrl.origin.length);
      if (url.startsWith(ProxyUrl.pathname)) {
        url = url.slice(ProxyUrl.pathname.length);
      }
      const [restoredUrl, found] = restoreUrl(url);
      if (found) {
        return restoredUrl;
      } else {
        return realProtocol + "://" + realHost + url;
      }
    }
    return url;
  }

  // Hijack postMessage (for iframe communication)
  const originalPostMessage = window.postMessage.bind(window);
  window.postMessage = function (message: any, targetOrigin: string, transfer?: Transferable[]): void {
    // Force targetOrigin to * to avoid cross-domain restrictions (since we are under proxy domain)
    originalPostMessage(message, "*", transfer || []);
  } as (typeof window)["postMessage"];

  // ==========================================
  // 6. Hijack Fetch and XMLHttpRequest
  // ==========================================
  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Inject custom Headers
    if (input instanceof Request) {
      const req = input;
      const headers = new Headers(req.headers);
      headers.set(HEADER_SITEPROXY_TARGET_PROTOCOL, ProxyRealProtocol);
      headers.set(HEADER_SITEPROXY_TARGET_HOST, ProxyRealHost);

      const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
      headers.set(HEADER_SITEPROXY_REAL_REFERER, realReferer);
      headers.set(HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME, (window.___location as LocationProxy).pathname);

      // Reconstruct Request with new headers
      input = new Request(req, { headers: headers });
    } else {
      const options = init || {};
      options.headers = new Headers(options.headers || {});
      options.headers.set(HEADER_SITEPROXY_TARGET_PROTOCOL, ProxyRealProtocol);
      options.headers.set(HEADER_SITEPROXY_TARGET_HOST, ProxyRealHost);

      const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
      options.headers.set(HEADER_SITEPROXY_REAL_REFERER, realReferer);
      options.headers.set(HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME, (window.___location as LocationProxy).pathname);
      init = options;
    }
    return originalFetch(input, init);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null
  ): void {
    // Call original open
    originalXHROpen.call(this, method, url, async, username, password);

    // Set custom headers
    this.setRequestHeader(HEADER_SITEPROXY_TARGET_PROTOCOL, ProxyRealProtocol);
    this.setRequestHeader(HEADER_SITEPROXY_TARGET_HOST, ProxyRealHost);
    const realReferer = constructProxyHelperUrl(window.location.href, ProxyRealProtocol, ProxyRealHost);
    this.setRequestHeader(HEADER_SITEPROXY_REAL_REFERER, realReferer);
    this.setRequestHeader(HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME, (window.___location as LocationProxy).pathname);
  };

  // ==========================================
  // 7. Helper Parsing Functions (Extract info from Proxy URL)
  // ==========================================

  function getPathnameFromProxyPrefixedURL(url: string): string {
    if (!url || !url.startsWith(ProxyUrl.href)) {
      return "";
    }
    url = url.slice(ProxyUrl.href.length);
    for (const mark of Marks) {
      if (url.startsWith(mark)) {
        const urlObj = new URL(markProto(mark) + "://" + url.slice(mark.length));
        return urlObj.pathname;
      }
    }
    return "";
  }

  function getHostFromProxyPrefixedURL(url: string): string {
    if (!url || !url.startsWith(ProxyUrl.href)) {
      return "";
    }
    url = url.slice(ProxyUrl.href.length);
    for (const mark of Marks) {
      if (url.startsWith(mark)) {
        const urlObj = new URL(markProto(mark) + "://" + url.slice(mark.length));
        return urlObj.host;
      }
    }
    return "";
  }

  function setProtocolFromProxyPrefixedURL(currentUrl: string, newProtocol: string): string {
    if (!newProtocol || !currentUrl.startsWith(ProxyUrl.href)) {
      return currentUrl;
    }
    const relativePath = currentUrl.slice(ProxyUrl.href.length);
    for (const mark of Marks) {
      if (relativePath.startsWith(mark)) {
        return ProxyUrl.href + newProtocol + "://" + currentUrl.slice(ProxyUrl.href.length + mark.length);
      }
    }
    return currentUrl;
  }

  function getProtocolFromProxyPrefixedURL(url: string): string {
    if (!url || !url.startsWith(ProxyUrl.href)) {
      return "";
    }
    url = url.slice(ProxyUrl.href.length);
    for (const mark of Marks) {
      if (url.startsWith(mark)) {
        return markProto(mark);
      }
    }
    return "https";
  }

  // Core Function: Remove proxy prefix, restore real URL
  function removeProxyPrefix(url: string): string {
    if (!url.startsWith(ProxyUrl.origin)) {
      return url;
    }
    const urlWithoutOrigin = url.slice(ProxyUrl.origin.length);
    if (urlWithoutOrigin.startsWith(ProxyUrl.pathname)) {
      const relativePath = urlWithoutOrigin.slice(ProxyUrl.pathname.length);
      const [restoredUrl, found] = restoreUrl(relativePath);
      if (found) {
        return restoredUrl;
      }
    }
    return ProxyRealProtocol + "://" + ProxyRealHost + urlWithoutOrigin;
  }

  /**
   * Real url => proxied url
   */
  function addProxyPrefix(url: string | null): string {
    if (!url || url.startsWith(ProxyUrl.href)) {
      return url || "";
    }

    // Ignore special protocols
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
      url.startsWith("vbscript:") ||
      url.startsWith("chrome-extension:")
    ) {
      return url;
    }

    // If starts with proxy origin, remove it to keep just path
    if (url.startsWith(ProxyUrl.origin)) {
      url = url.slice(ProxyUrl.origin.length);
    }

    // Handle absolute paths inside string (e.g., in regex replacement)
    const regexMap: Record<string, string> = { "()(https?://|//)([^\\s\"']+)": "" };
    for (const regexStr in regexMap) {
      const regex = new RegExp(regexStr, "gi");
      url = url.replace(regex, (match, p1, protocolPart, hostPart, offset, string) => {
        const protocol = protocolPart === "//" ? "https" : protocolPart.replace("://", "").toLowerCase();
        return ProxyUrl.href + protocol + "://" + hostPart;
      });
    }

    // Clean duplicate prefixes
    if (url === "//" + ProxyUrl.host || url.startsWith("//" + ProxyUrl.host + "/")) {
      url = url.slice(2 + ProxyUrl.host.length);
    }

    // Construct full proxy URL
    const defaultProxyBase = ProxyUrl.href + ProxyRealProtocol + "://" + ProxyRealHost;

    if (url.startsWith("//")) {
      url = ProxyUrl.href + "https://" + url.slice(2);
    } else if (url.startsWith("/")) {
      url = defaultProxyBase + url;
    }
    return url;
  }

  /*
Native API Monkey Patching to make our MutationObserver work with sync page script. E.g.

var n = document.createElement("a");
n.id = "newPageTab",
n.target = t || "_blank",
n.href = "...",
document.body.appendChild(n),
n.click(),
document.body.removeChild(n)

By default, MutationObserver doesn't capture the above code because it's designed to be performant,
so it is asynchronous. It waits for the current script execution to finish before firing its callback.

To make it work, we must intercept the element synchronously before it is used.
The most robust way to do this is to override (monkey patch) native DOM insertion methods,
force our rewrite logic to run immediately before the node enters the DOM.

With the override in place, the flow becomes:
1. Script: n.href = "..."
2. Script: document.body.appendChild(n)
  - Our Hook: traverseAndRewriteNode(n) runs synchronously.
  - Our Hook: n.href is rewritten to the proxied URL.
  - Our Hook: originalAppendChild puts the safe node into the DOM.
3. Script: n.click() triggers navigation using the proxied URL.

   */
  // 1. Capture the original native methods
  const originalAppendChild = Node.prototype.appendChild;
  const originalInsertBefore = Node.prototype.insertBefore;
  // 2. Override appendChild
  Node.prototype.appendChild = function <T extends Node>(node: T): T {
    // Force a rewrite BEFORE the node is actually inserted
    traverseAndRewriteNode(node);
    // Proceed with the original logic
    return originalAppendChild.call(this, node) as T;
  };
  // 3. Override insertBefore (just in case)
  Node.prototype.insertBefore = function <T extends Node>(node: T, child: Node | null): T {
    traverseAndRewriteNode(node);
    return originalInsertBefore.call(this, node, child) as T;
  };
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string): void {
    // Check if we care about this attribute
    if (monitoredAttributes.includes(name)) {
      const proxiedValue = addProxyPrefix(value);
      // Call original with the NEW value
      return originalSetAttribute.call(this, name, proxiedValue);
    }
    // Pass through unrelated attributes untouched
    return originalSetAttribute.call(this, name, value);
  };
  // --- End Native Overrides ---

  // ==========================================
  // 8. DOM Observation & Auto URL Rewriting (MutationObserver)
  // ==========================================
  const monitoredAttributes = ["src", "href", "action", "data-url", "srcset"];
  const observerConfig: MutationObserverInit = {
    attributes: true,
    childList: true,
    subtree: true,
    attributeOldValue: true,
    characterDataOldValue: true,
    attributeFilter: monitoredAttributes,
  };

  // MutationObserver Callback
  const handleMutationCallback: MutationCallback = (mutations, observer) => {
    observer.disconnect(); // Pause listening to prevent loops
    mutations.forEach((mutation) => {
      switch (mutation.type) {
        case "attributes":
          if (!mutation.target || !(mutation.target instanceof Element)) break;
          const target = mutation.target as Element;
          if (!mutation.attributeName) break;

          const attrValue = target.getAttribute(mutation.attributeName);
          if (attrValue !== null && monitoredAttributes.includes(mutation.attributeName)) {
            const proxiedValue = addProxyPrefix(attrValue);

            // Remove integrity attribute
            if (target.tagName.toLowerCase() === "script" && target.hasAttribute("integrity")) {
              target.removeAttribute("integrity");
            }

            if (proxiedValue !== attrValue) {
              target.setAttribute(mutation.attributeName, proxiedValue);
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
  };

  // Recursive Node Traversal
  function traverseAndRewriteNode(node: Node): void {
    if (node._traversed) return;
    node._traversed = true;

    node.childNodes.forEach((child) => {
      traverseAndRewriteNode(child);
    });

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;

      monitoredAttributes.forEach((attr) => {
        if (element.hasAttribute(attr)) {
          const val = element.getAttribute(attr);
          const proxiedVal = addProxyPrefix(val);

          if (element.tagName.toLowerCase() === "script" && element.hasAttribute("integrity")) {
            element.removeAttribute("integrity");
          }

          if (proxiedVal !== val && proxiedVal !== null) {
            element.setAttribute(attr, proxiedVal);
          }
        }
      });

      // Special handling for iframe
      if (element.tagName.toLowerCase() === "iframe") {
        const iframe = element as HTMLIFrameElement;
        if (!node._loadListenerAdded) {
          node._loadListenerAdded = true;
          iframe.addEventListener("load", function () {
            const doc = iframe.contentDocument;
            if (doc && !doc._observerSet) {
              doc._observerSet = true;
              traverseAndRewriteNode(doc); // doc acts as a Node here
              const iframeObserver = new MutationObserver(handleMutationCallback);
              iframeObserver.observe(doc.documentElement, observerConfig);
            }
          });
        }
      }

      // Direct iframe content handling (if same origin accessible)
      if (element.tagName.toLowerCase() === "iframe") {
        const iframe = element as HTMLIFrameElement;
        const doc = iframe.contentDocument;
        if (doc && !doc._observerSet) {
          doc._observerSet = true;
          traverseAndRewriteNode(doc);
          const iframeObserver = new MutationObserver(handleMutationCallback);
          iframeObserver.observe(doc.documentElement, observerConfig);
        }
      }
    }
  }

  // ==========================================
  // 9. Display Top Navigation Bar (Address Bar)
  // ==========================================
  function showHeader(): void {
    if (HIDE_TOP || sessionStorage.getItem("siteproxy_navbar_hidden")) {
      return;
    }

    const barHeight = "40px";
    const bar = document.createElement("div");
    bar.id = "siteproxy-navbar-container";

    // Navigation Bar Styles
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: barHeight,
      backgroundColor: "#333333",
      borderBottom: "1px solid #000",
      zIndex: "2147483647", // Max z-index
      display: "flex",
      alignItems: "center",
      padding: "0 10px",
      boxSizing: "border-box",
      fontFamily: "Arial, sans-serif",
      boxShadow: "0 2px 5px rgba(0,0,0,0.3)",
    });

    const form = document.createElement("form");
    form.onsubmit = function (e) {
      e.preventDefault();
      const targetUrl = fixInputUrl(input.value);
      if (!targetUrl) {
        return;
      }
      window.location.href = addProxyPrefix(targetUrl);
    };
    Object.assign(form.style, {
      display: "flex",
      width: "100%",
      margin: "0",
    });

    // 1. Home Button
    const hpBtn = document.createElement("button");
    hpBtn.type = "button";
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
    hpBtn.onclick = function (e: MouseEvent) {
      e.preventDefault();
      location.href = ProxyUrl.pathname;
    };

    // 2. URL Input
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter URL...";
    input.value = window.___location
      ? (window.___location as LocationProxy).href
      : removeProxyPrefix(window.location.href);

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

    input.onfocus = function () {
      input.select();
    };

    // 3. Submit (Go) Button
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
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

    submitBtn.onmouseover = function () {
      submitBtn.style.backgroundColor = "#45a049";
    };
    submitBtn.onmouseout = function () {
      submitBtn.style.backgroundColor = "#4CAF50";
    };

    // 4. Close (X) Button
    const closeBtn = document.createElement("button");
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
      closeBtn.style.color = "#fff";
    };
    closeBtn.onmouseout = function () {
      closeBtn.style.color = "#aaa";
    };

    closeBtn.onclick = function (e: MouseEvent) {
      e.preventDefault();
      bar.style.display = "none";
      if (document.body) document.body.style.marginTop = "0";
      sessionStorage.setItem("siteproxy_navbar_hidden", "true");
    };

    // Assemble
    form.appendChild(hpBtn);
    form.appendChild(input);
    form.appendChild(submitBtn);
    bar.appendChild(form);
    bar.appendChild(closeBtn);

    if (document.body) {
      document.body.insertBefore(bar, document.body.firstChild);
      document.body.style.marginTop = barHeight;
    }
  }

  // Start Main Observer
  const mainObserver = new MutationObserver(handleMutationCallback);
  mainObserver.observe(document.documentElement, observerConfig);

  // DOMContentLoaded Event
  document.addEventListener("DOMContentLoaded", () => {
    traverseAndRewriteNode(document.documentElement);
    showHeader();

    // Regular check for non-jsdom environments
    if (typeof navigator === "object" && !navigator.userAgent.includes("jsdom")) {
      setTimeout(ensureTrailingSlash, 2000);
    }
  });

  // ==========================================
  // 10. Service Worker Registration & Communication
  // ==========================================

  function notifySWUrlMap(pathname: string, realProtocol: string, realHost: string): void {
    if (window.proxy_worker_registration && window.proxy_worker_registration.active) {
      const msg: ProxyUrlHostMapMsg = {
        type: "PROXY_URL_HOST_MAP",
        data: {
          pathname: pathname,
          real_protocol: realProtocol,
          real_host: realHost,
        },
      };
      window.proxy_worker_registration.active.postMessage(msg);
    }
  }

  function notifySWCurrentLocation(): void {
    if (!ProxyRealProtocol || window.self !== window.top) {
      return;
    }
    if (window.proxy_worker_registration && window.proxy_worker_registration.active) {
      const msg: ProxyCurLocationMsg = {
        type: "PROXY_CUR_LOCATION",
        data: {
          protocol: ProxyRealProtocol,
          host: ProxyRealHost,
        },
      };
      window.proxy_worker_registration.active.postMessage(msg);
    }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      const isRegistered = registrations.some(function (reg) {
        const isActive = reg.active && reg.active.scriptURL.includes(PREFIX + "sw.js");
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
          const params = new URLSearchParams({
            [VAR_PROXY_URL]: ProxyUrl.href,
            [VAR_PROXY_REAL_PROTOCOL]: ProxyRealProtocol,
            [VAR_PROXY_REAL_HOST]: ProxyRealHost,
            [VAR_PROXY_DEBUG]: DEBUG,
          });

          navigator.serviceWorker.register(`/${PREFIX}sw.js?${params.toString()}`).then(
            function (reg) {
              console.log(
                `siteproxy_service_worker registered. scope=${reg.scope}, protocol=${ProxyRealProtocol}, host=${ProxyRealHost}`
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
  // 11. Specific Site Fixes
  // ==========================================

  // Github form submission fix
  if (isBaseOrSubHost(ProxyRealHost, "github.com")) {
    setTimeout(() => {
      const form = document.querySelector("form");
      if (form) {
        form.addEventListener("submit", function (e: Event) {
          e.preventDefault();
          const target = e.target as HTMLFormElement;
          const action = target.action;
          const method = target.method || METHOD_POST;
          const formData = new FormData(target);

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
      }
    }, 4000);
  }

  function ensureTrailingSlash(): void {
    const location = window.___location as LocationProxy;
    const { pathname, search, hash, href } = location;
    if (window.self === window.top && pathname === "/" && search === "" && hash === "" && !href.endsWith("/")) {
      location.href = href + "/";
    }
  }

  // Expose globals for debugging or SW usage
  (window as any).siteproxyAttributeChanged = handleMutationCallback;
  (window as any).removeProxyPrefix = removeProxyPrefix;
  (window as any).setProtocolFromProxyPrefixedURL = setProtocolFromProxyPrefixedURL;
  (window as any).traverseAndModifyNode = traverseAndRewriteNode;
  (window as any).siteproxyRegReplacement = addProxyPrefix;
})();
