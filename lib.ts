// Common codes shared by index (backend) / inject / sw

/**
 * filename / url path prefix for siteproxy
 */
export const PREFIX = "__siteproxy_";

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
export const HEADER_ACCEPT_ENCODING = "Accept-Encoding";
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
export const HEADER_SITEPROXY_WINDOW_LOCATION_PATHNAME = "siteproxy-window-location-pathname";

export const CONTENT_DISPOSITION_ATTACHMENT = "attachment";
export const CACHE_CONTROL_NO_CACHE = "no-cache, no-store, must-revalidate";
export const CLEAR_SITE_DATA_ALL = `"*"`;

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
 * If url doesn't match any mark prefix, return as is.
 */
export function restoreUrl(url: string): string {
  for (const mark of Marks) {
    if (url.startsWith(mark)) {
      return markProto(mark) + "://" + url.slice(mark.length);
    } else if (url.startsWith("/" + mark)) {
      return markProto(mark) + "://" + url.slice(mark.length + 1);
    }
  }
  return url;
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
