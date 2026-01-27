// Common codes shared by index (backend) / inject / sw.

export const DEFAULT_SITENAME = "Siteproxy";

/**
 * filename / url path prefix for siteproxy
 */
export const PREFIX = "__siteproxy_";

/**
 * `__siteproxy_direct__`
 */
export const FLAG_DIRECT = PREFIX + "direct__";

/**
 * `__siteproxy_raw__`
 */
export const FLAG_RAW = PREFIX + "raw__";

export const METHOD_GET = "GET";
export const METHOD_HEAD = "HEAD";
export const METHOD_OPTIONS = "OPTIONS";
export const METHOD_TRACE = "TRACE";
export const METHOD_POST = "POST";
export const METHOD_PUT = "PUT";
export const METHOD_PATCH = "PATCH";
export const METHOD_DELETE = "DELETE";
export const METHOD_CONNECT = "CONNECT";
// webdav extend methods
export const METHOD_ACL = "ACL";
export const METHOD_BIND = "BIND";
export const METHOD_CHECKOUT = "CHECKOUT";
export const METHOD_COPY = "COPY";
export const METHOD_LOCK = "LOCK";
export const METHOD_MERGE = "MERGE";
export const METHOD_MKACTIVITY = "MKACTIVITY";
export const METHOD_MKCALENDAR = "MKCALENDAR";
export const METHOD_MKCOL = "MKCOL";
export const METHOD_MOVE = "MOVE";
export const METHOD_PROPFIND = "PROPFIND";
export const METHOD_PROPPATCH = "PROPPATCH";
export const METHOD_PURGE = "PURGE";
export const METHOD_REBIND = "REBIND";
export const METHOD_REPORT = "REPORT";
export const METHOD_SEARCH = "SEARCH";
export const METHOD_UNBIND = "UNBIND";
export const METHOD_UNCHECKOUT = "UNCHECKOUT";
export const METHOD_UNLOCK = "UNLOCK";
export const METHOD_UPDATE = "UPDATE";
export const METHOD_VERSION_CONTROL = "VERSION-CONTROL";

/**
 * all http methods, including extensions methods like WebDAV.
 */
export const ALL_METHODS = [
  METHOD_GET,
  METHOD_HEAD,
  METHOD_OPTIONS,
  METHOD_TRACE,
  METHOD_POST,
  METHOD_PUT,
  METHOD_PATCH,
  METHOD_DELETE,
  METHOD_CONNECT,

  METHOD_ACL,
  METHOD_BIND,
  METHOD_CHECKOUT,
  METHOD_COPY,
  METHOD_LOCK,
  METHOD_MERGE,
  METHOD_MKACTIVITY,
  METHOD_MKCALENDAR,
  METHOD_MKCOL,
  METHOD_MOVE,
  METHOD_PROPFIND,
  METHOD_PROPPATCH,
  METHOD_PURGE,
  METHOD_REBIND,
  METHOD_REPORT,
  METHOD_SEARCH,
  METHOD_UNBIND,
  METHOD_UNCHECKOUT,
  METHOD_UNLOCK,
  METHOD_UPDATE,
  METHOD_VERSION_CONTROL,
] as const;

export const NO_REQUEST_BODY_METHODS = [
  METHOD_GET,
  METHOD_HEAD,
  METHOD_TRACE,
  METHOD_OPTIONS,
  METHOD_PROPFIND,
] as const;

export const WITH_REQUEST_BODY_METHODS = [
  METHOD_POST,
  METHOD_PUT,
  METHOD_PATCH,
  METHOD_PROPPATCH,
  METHOD_MKCOL,
] as const;

// For compatibility, define all headers as full lowercase form.
export const HEADER_CONTENT_TYPE = "content-type";
export const HEADER_CONTENT_LENGTH = "content-length";
export const HEADER_CONTENT_ENCODING = "content-encoding";
export const HEADER_TRANSFER_ENCODING = "transfer-encoding";
export const HEADER_SET_COOKIE = "set-cookie";
export const HEADER_COOKIE = "cookie";
export const HEADER_X_FRAME_OPTIONS = "x-frame-options";
export const HEADER_LOCATION = "location";
export const HEADER_HOST = "host";
export const HEADER_X_FORWARDED_FOR = "x-forwarded-for";
export const HEADER_CF_CONNECTING_IP = "cf-connecting-ip";
export const HEADER_CONTENT_SECURITY_POLICY = "content-security-policy";
export const HEADER_CONTENT_SECURITY_POLICY_REPORT_ONLY = "content-security-policy-report-only";
export const HEADER_ACCEPT_ENCODING = "accept-encoding";
export const HEADER_SEC_FETCH_DEST = "sec-fetch-dest";
export const HEADER_CONTENT_DISPOSITION = "content-disposition";
export const HEADER_CACHE_CONTROL = "cache-control";
export const HEADER_CLEAR_SITE_DATA = "clear-site-data";
export const HEADER_REFERER = "referer";
export const HEADER_ORIGIN = "origin";
export const HEADER_PREFIX_SITEPROXY = "siteproxy-";
export const HEADER_SITEPROXY_TARGET_PROTOCOL = "siteproxy-target-protocol";
export const HEADER_SITEPROXY_TARGET_HOST = "siteproxy-target-host";
export const HEADER_SITEPROXY_REAL_REFERER = "siteproxy-real-referer";
export const HEADER_SITEPROXY_NEWREFERER = "siteproxy-newreferer";
export const HEADER_SITEPROXY_DEST = "siteproxy-dest";
export const HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME = "siteproxy-window-location-pathname";

export const FETCH_DEST_DOCUMENT = "document";
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest .
// Note all fetch requests (either by page or service worker) will have "empty" dest value.
export const HTML_MODIFIABLE_FETCH_DEST_ = ["document", "iframe", "frame", "fencedframe"] as const;
export const JS_MODIFIABLE_FETCH_DEST = ["script", "worker", "serviceworker", "sharedworker"] as const;

export const CONTENT_DISPOSITION_ATTACHMENT = "attachment";
export const CACHE_CONTROL_NO_CACHE = "no-cache, no-store, must-revalidate";
export const CLEAR_SITE_DATA_ALL = `"*"`;

export const VAR_URL = "url";
export const VAR_PROXY_URL = "proxy_url";
export const VAR_PROXY_REAL_PROTOCOL = "proxy_real_protocol";
export const VAR_PROXY_REAL_HOST = "proxy_real_host";
export const VAR_PROXY_DEBUG = "proxy_debug";

export const HTTPS = "https";
export const HTTP = "http";

export const Marks = ["https/", "https://", "http/", "http://"] as const;

/**
 * Return mark protocol
 */
export function markProto(mark: (typeof Marks)[number]): "https" | "http" {
  return mark.startsWith(HTTPS) ? HTTPS : HTTP;
}

/**
 * Restore "https/example.com" or "/https/example.com" style url to canonical form "https://example.com" .
 * If url doesn't match any mark prefix, return [url, false].
 */
export function restoreUrl(url: string): [url: string, found: boolean] {
  for (const mark of Marks) {
    if (url.startsWith(mark)) {
      return [markProto(mark) + "://" + url.slice(mark.length), true];
    } else if (url.startsWith("/" + mark)) {
      return [markProto(mark) + "://" + url.slice(mark.length + 1), true];
    }
  }
  return [url, false];
}

/**
 * Try to fix a user input url like "example.com" and return canonical form like "https://example.com".
 * Return "" if url is undefined / null / empty (after trimmed).
 */
export function fixInputUrl(url: string | undefined | null): string {
  if (!url) {
    return "";
  }
  url = url.trim();
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url;
}

export function escapeRegExp(str: string): string {
  // $& means the whole matched string
  return (RegExp as any).escape ? (RegExp as any).escape(str) : str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldLog(url: string, DEBUG?: string): boolean {
  if (!DEBUG || DEBUG === "0") {
    return false;
  }
  if (DEBUG === "1" || DEBUG === "*") {
    return true;
  }
  return DEBUG.split(/\s*,\s*/).some((keyword) => url.includes(keyword));
}

/**
 * Convert str to int. If str is null / undefined / empty / invalid (NaN), return defaultValue
 * @param str
 * @param defaultValue Optional, default is 0 (zero).
 * @returns
 */
export function str2int(str?: string | undefined | null, defaultValue = 0): number {
  if (!str) {
    return defaultValue;
  }
  const value = parseInt(str);
  if (isNaN(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * Return true if target (e.g. "www.google.com") equals with or is a subdomain of base (e.g. "google.com").
 */
export function isBaseOrSubHost(target: string, base: string): boolean {
  return target === base || target.endsWith("." + base);
}

// Interface for Service Worker Messages
export interface ProxyUrlHostMapMsg {
  type: "PROXY_URL_HOST_MAP";
  data: {
    pathname: string;
    real_protocol: string;
    real_host: string;
  };
}

export interface ProxyCurLocationMsg {
  type: "PROXY_CUR_LOCATION";
  data: {
    protocol: string;
    host: string;
  };
}

export type ProxyMsg = ProxyUrlHostMapMsg | ProxyCurLocationMsg;
