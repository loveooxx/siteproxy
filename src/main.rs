// Rust version backend, embed client files.
const VERSION: &str = "2.5.5";

use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use lazy_static::lazy_static;
use regex::{Regex, RegexBuilder};
use reqwest::Client;
use rust_embed::RustEmbed;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tower_http::compression::CompressionLayer;
use url::Url;

const PREFIX: &str = "__siteproxy_";
const FLAG_RAW: &str = "__siteproxy_raw__";
const HEADER_PREFIX_SITEPROXY: &str = "siteproxy-";
const HEADER_SITEPROXY_TARGET_PROTOCOL: &str = "siteproxy-target-protocol";
const HEADER_SITEPROXY_TARGET_HOST: &str = "siteproxy-target-host";
const HEADER_SITEPROXY_NEWREFERER: &str = "siteproxy-newreferer";
const HEADER_SITEPROXY_DEST: &str = "siteproxy-dest";
const HEADER_CLEAR_SITE_DATA: &str = "clear-site-data";
const HEADER_SEC_FETCH_DEST: &str = "sec-fetch-dest";
const MIME_HTML: &str = "text/html";
const MIME_JS: &str = "application/javascript";
const MIME_JS2: &str = "text/javascript";
const CHARSET_UTF8: &str = "utf-8";
const CACHE_CONTROL_NO_CACHE: &str = "no-cache, no-store, must-revalidate";
const CLEAR_SITE_DATA_ALL: &str = r#""*""#;
const CONTENT_TYPE_HTML: &str = "text/html; charset=utf-8";
const CONTENT_TYPE_JS: &str = "application/javascript; charset=utf-8";

#[derive(RustEmbed)]
#[folder = "dist/"]
struct Assets;

#[derive(Clone, Debug)]
enum DebugConfig {
    Boolean(bool),
    Keywords(Vec<String>),
}

impl DebugConfig {
    fn should_log(&self, url: &str) -> bool {
        match self {
            DebugConfig::Boolean(b) => *b,
            DebugConfig::Keywords(keywords) => keywords.iter().any(|k| url.contains(k)),
        }
    }
}

#[derive(Clone)]
struct AppState {
    client: Client,
    proxy_url: Url,
    blacklist: Option<HashSet<String>>,
    whitelist: Option<HashSet<String>>,
    script: Option<String>,
    script_domains: Option<HashSet<String>>,
    debug: DebugConfig,
}

struct BodyModRule {
    domain: Option<String>,
    regex: Regex,
    replacement: String,
}

lazy_static! {
    static ref BODY_MOD_RULES: Vec<BodyModRule> = vec![
        BodyModRule {
            domain: Some("google.com".to_string()),
            regex: Regex::new(r";\w+?\.integrity='sha.+?';").unwrap(),
            replacement: ";".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\.URL\b").unwrap(),
            replacement: ".___URL".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\bdomain\b").unwrap(),
            replacement: "___domain".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\blocation\b").unwrap(),
            replacement: "___location".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\bpushState\b").unwrap(),
            replacement: "___pushState".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\breplaceState\b").unwrap(),
            replacement: "___replaceState".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\bnavigator.serviceWorker\b").unwrap(),
            replacement: "navigator.___serviceWorker".to_string()
        },
        BodyModRule {
            domain: None,
            regex: Regex::new(r"\bdocument.requestStorageAccessFor\b").unwrap(),
            replacement: "document.___requestStorageAccessFor".to_string()
        },
    ];
    static ref PATH_TARGET_REGEX: Regex =
        Regex::new(r"^(?:(https?)(?::\/\/|\/))([-a-z0-9A-Z.:]+)(\/.*)?$").unwrap();
    static ref META_CHARSET_REGEX: Regex =
        RegexBuilder::new(r#"<meta\s+[^>]*charset\s*=\s*["']?([0-9a-zA-Z\-]+)["']?[^>]*>"#)
            .case_insensitive(true)
            .build()
            .unwrap();
    static ref URL_KEYWORD_BLACKLIST: Vec<&'static str> = vec!["https://web.telegram.org/k/sw-"];
    static ref BODY_MOD_DOMAIN_BLACKLIST: HashSet<&'static str> =
        HashSet::from(["telegram.org", "nga.178.com"]);
    static ref HTML_MODIFIABLE_FETCH_DEST: HashSet<&'static str> =
        HashSet::from(["document", "iframe", "frame", "fencedframe"]);
    static ref JS_MODIFIABLE_FETCH_DEST: HashSet<&'static str> =
        HashSet::from(["script", "worker", "serviceworker", "sharedworker"]);
}

fn parse_debug_config(s: Option<String>) -> DebugConfig {
    match s.as_deref() {
        None | Some("") | Some("0") => DebugConfig::Boolean(false),
        Some("1") => DebugConfig::Boolean(true),
        Some(other) => {
            let keywords: Vec<String> = other
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if keywords.is_empty() {
                DebugConfig::Boolean(false)
            } else {
                DebugConfig::Keywords(keywords)
            }
        }
    }
}

fn str_to_set(s: Option<String>) -> Option<HashSet<String>> {
    s.map(|v| {
        v.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

fn allow_domain(
    domain: &str,
    blacklist: &Option<HashSet<String>>,
    whitelist: &Option<HashSet<String>>,
) -> bool {
    let mut d = domain;
    loop {
        if let Some(bl) = blacklist {
            if bl.contains(d) {
                return false;
            }
        }
        if let Some(wl) = whitelist {
            if wl.contains(d) {
                return true;
            }
        }
        match d.find('.') {
            Some(i) => d = &d[i + 1..],
            None => break,
        }
    }
    if whitelist.is_some() {
        return false;
    }
    true
}

fn restore_url(url: &str) -> (String, bool) {
    let marks = ["https/", "https://", "http/", "http://"];
    for mark in marks {
        if let Some(rest) = url.strip_prefix(mark) {
            let proto = if mark.starts_with("https") {
                "https"
            } else {
                "http"
            };
            return (format!("{}://{}", proto, rest), true);
        } else if let Some(rest) = url.strip_prefix(&format!("/{}", mark)) {
            let proto = if mark.starts_with("https") {
                "https"
            } else {
                "http"
            };
            return (format!("{}://{}", proto, rest), true);
        }
    }
    (url.to_string(), false)
}

fn parse_target(path_str: &str) -> (String, String, String) {
    if let Some(caps) = PATH_TARGET_REGEX.captures(path_str) {
        let proto = caps.get(1).map_or("", |m| m.as_str()).to_string();
        let host = caps.get(2).map_or("", |m| m.as_str()).to_string();
        let path = caps.get(3).map_or("", |m| m.as_str()).to_string();
        (proto, host, path)
    } else {
        (String::new(), String::new(), String::new())
    }
}

async fn serve_asset(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() || path.ends_with("/") {
        format!("{}index.html", PREFIX)
    } else {
        path.to_string()
    };

    match Assets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn api_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL_NO_CACHE),
    );
    let action = params.get("action").map(|s| s.as_str()).unwrap_or("");
    match action {
        "clear" => {
            headers.insert(
                HEADER_CLEAR_SITE_DATA,
                HeaderValue::from_static(CLEAR_SITE_DATA_ALL),
            );
            headers.insert(
                header::LOCATION,
                HeaderValue::from_str(state.proxy_url.path()).unwrap(),
            );
            (StatusCode::FOUND, headers).into_response()
        }
        "go" => {
            let url = params.get("url").map(|s| s.trim()).unwrap_or("");
            let target = if !url.is_empty() && !url.starts_with("http") {
                format!("https://{}", url)
            } else {
                url.to_string()
            };
            if !target.is_empty() {
                let redirect_path = format!("{}{}", state.proxy_url.path(), target);
                headers.insert(
                    header::LOCATION,
                    HeaderValue::from_str(&redirect_path).unwrap(),
                );
                (StatusCode::FOUND, headers).into_response()
            } else {
                (StatusCode::BAD_REQUEST, headers).into_response()
            }
        }
        _ => (StatusCode::BAD_REQUEST, headers).into_response(),
    }
}

// --- Main Proxy Logic ---

async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let url_str = uri.to_string();

    // DEBUG: Check URL against DebugConfig
    let mut debug = state.debug.should_log(&url_str);

    if debug {
        println!("{} {}", method, url_str);
    }

    // 1. Determine Target URL
    let path_after_token;
    let req_url_path = uri.path();
    let proxy_path = state.proxy_url.path();

    if req_url_path.starts_with(proxy_path)
        && (req_url_path.len() > proxy_path.len())
        && (req_url_path[proxy_path.len()..].starts_with("http")
            || req_url_path[proxy_path.len()..].starts_with("https"))
    {
        path_after_token = req_url_path[proxy_path.len()..].to_string();
    } else if let Some(proto) = headers.get(HEADER_SITEPROXY_TARGET_PROTOCOL) {
        let proto = proto.to_str().unwrap_or("");
        let host = headers
            .get(HEADER_SITEPROXY_TARGET_HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        path_after_token = format!("{}://{}{}", proto, host, req_url_path);
    } else {
        return StatusCode::NOT_FOUND.into_response();
    }

    let (t_proto, t_host, t_path) = parse_target(&path_after_token);
    if t_proto != "http" && t_proto != "https" {
        return StatusCode::NOT_FOUND.into_response();
    }

    let query = uri.query().unwrap_or("");
    let mut target_url_str = format!("{}://{}{}", t_proto, t_host, t_path);
    if !query.is_empty() {
        let proxy_base = state.proxy_url.to_string();
        let cleaned_query = query.replace(&format!("{}http", proxy_base), "http");
        target_url_str.push('?');
        target_url_str.push_str(&cleaned_query);
    }

    // DEBUG: Re-evaluate debug status with the real target URL
    if !debug {
        debug = state.debug.should_log(&target_url_str);
    }

    let target_url = match Url::parse(&target_url_str) {
        Ok(u) => u,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    if !allow_domain(
        target_url.host_str().unwrap_or(""),
        &state.blacklist,
        &state.whitelist,
    ) {
        if debug {
            println!("Blocked: {}", target_url);
        }
        return StatusCode::NOT_FOUND.into_response();
    }
    if URL_KEYWORD_BLACKLIST
        .iter()
        .any(|k| target_url_str.contains(k))
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    let mut req_headers = headers.clone();
    let keys_to_remove: Vec<HeaderName> = req_headers
        .keys()
        .filter(|k| {
            let k_str = k.as_str().to_lowercase();
            k_str.starts_with(HEADER_PREFIX_SITEPROXY)
                || [
                    // IP / Proxy stuff
                    "x-forwarded-for",
                    "x-real-ip",
                    "cf-connecting-ip",
                    // Hop-by-hop headers (CRITICAL for HTTP/2)
                    "connection",
                    "keep-alive",
                    "proxy-authenticate",
                    "proxy-authorization",
                    "te",
                    "trailers",
                    "accept-encoding",
                    "transfer-encoding",
                    "upgrade",
                    // We handle Host manually
                    "host",
                ]
                .contains(&k_str.as_str())
        })
        .cloned()
        .collect();
    for k in keys_to_remove {
        req_headers.remove(k);
    }
    req_headers.remove(header::ACCEPT_ENCODING);

    req_headers.insert(
        header::HOST,
        HeaderValue::from_str(target_url.host_str().unwrap()).unwrap(),
    );

    if let Some(new_ref) = headers.get(HEADER_SITEPROXY_NEWREFERER) {
        req_headers.insert(header::REFERER, new_ref.clone());
        if let Ok(ref_url) = Url::parse(new_ref.to_str().unwrap_or("")) {
            let origin = format!(
                "{}://{}",
                ref_url.scheme(),
                ref_url.host_str().unwrap_or("")
            );
            if let Ok(val) = HeaderValue::from_str(&origin) {
                req_headers.insert(header::ORIGIN, val);
            }
        }
    } else if let Some(referer) = req_headers.get(header::REFERER) {
        let ref_str = referer.to_str().unwrap_or("");
        if ref_str.starts_with(state.proxy_url.as_str()) {
            let suffix = &ref_str[state.proxy_url.as_str().len()..];
            let (real_ref, _) = restore_url(suffix);
            if let Ok(val) = HeaderValue::from_str(&real_ref) {
                req_headers.insert(header::REFERER, val);
            }
            req_headers.insert(
                header::ORIGIN,
                HeaderValue::from_str(&format!(
                    "{}://{}",
                    target_url.scheme(),
                    target_url.host_str().unwrap()
                ))
                .unwrap(),
            );
        }
    }

    if debug {
        println!("Fetch: {}, {:?}", target_url, req_headers);
    }

    let client_req = state
        .client
        .request(method.clone(), target_url.clone())
        .headers(req_headers);

    let client_req = match method {
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE => {
            // No body for these methods
            client_req
        }
        _ => {
            // Attach body for POST, PUT, etc.
            client_req.body(body)
        }
    };

    let res_result = client_req.send().await;

    let res = match res_result {
        Ok(r) => r,
        Err(e) => {
            if debug {
                println!("Fetch Error: {}", e);
            }
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let status = res.status();
    let mut res_headers = res.headers().clone();

    let mut new_cookies = Vec::new();
    for (key, value) in res_headers.iter() {
        if key == header::SET_COOKIE {
            if let Ok(s) = value.to_str() {
                let mut new_cookie = s.to_string();
                new_cookie = Regex::new(r"(?i)Domain=[^;]*?(;|$)")
                    .unwrap()
                    .replace_all(
                        &new_cookie,
                        format!("Domain={};", state.proxy_url.host_str().unwrap()),
                    )
                    .to_string();
                new_cookie = Regex::new(r"(?i)Path=([^;]*?)(;|$)")
                    .unwrap()
                    .replace_all(&new_cookie, "Path=/;")
                    .to_string();
                if !new_cookie.to_lowercase().contains("path=") {
                    new_cookie.push_str("; Path=/;");
                }
                new_cookies.push(new_cookie);
            }
        }
    }

    res_headers.remove(header::SET_COOKIE);
    res_headers.remove(header::CONTENT_SECURITY_POLICY);
    res_headers.remove(header::CONTENT_SECURITY_POLICY_REPORT_ONLY);
    res_headers.remove(header::X_FRAME_OPTIONS);
    res_headers.remove(header::TRANSFER_ENCODING);
    res_headers.remove(header::CONTENT_ENCODING);
    res_headers.remove(header::CONTENT_LENGTH);

    if status.is_redirection() {
        if let Some(loc) = res_headers.get(header::LOCATION) {
            if let Ok(loc_str) = loc.to_str() {
                let new_loc = if loc_str.starts_with('/') {
                    format!(
                        "{}{}{}",
                        state.proxy_url,
                        target_url.origin().ascii_serialization(),
                        loc_str
                    )
                } else {
                    match Url::parse(loc_str) {
                        Ok(l_url) => {
                            if l_url.origin() != state.proxy_url.origin() {
                                format!("{}{}", state.proxy_url, loc_str)
                            } else {
                                loc_str.to_string()
                            }
                        }
                        Err(_) => loc_str.to_string(),
                    }
                };
                res_headers.insert(
                    header::LOCATION,
                    HeaderValue::from_str(&new_loc).unwrap_or(loc.clone()),
                );
            }
        }
    }

    let content_type = res_headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let is_html = content_type.contains(MIME_HTML);
    let is_js = content_type.contains(MIME_JS) || content_type.contains(MIME_JS2);
    let fetch_dest = headers
        .get(HEADER_SITEPROXY_DEST)
        .or(headers.get(HEADER_SEC_FETCH_DEST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let should_modify = !target_url_str.contains(FLAG_RAW)
        && (is_html && HTML_MODIFIABLE_FETCH_DEST.contains(fetch_dest)
            || is_js && JS_MODIFIABLE_FETCH_DEST.contains(fetch_dest))
        && !fetch_dest.is_empty()
        && !BODY_MOD_DOMAIN_BLACKLIST.contains(target_url.host_str().unwrap_or(""))
        && status != StatusCode::NO_CONTENT;

    let body_bytes = match res.bytes().await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };

    let (final_body, is_utf8) = if should_modify {
        modify_content(
            &state,
            &target_url,
            body_bytes,
            is_html,
            &content_type,
            debug,
        )
        .await
    } else {
        (body_bytes, false)
    };
    if is_utf8 {
        res_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(if is_html {
                CONTENT_TYPE_HTML
            } else {
                CONTENT_TYPE_JS
            })
            .unwrap(),
        );
    }

    let mut builder = Response::builder().status(status);
    let builder_headers = builder.headers_mut().unwrap();

    for (k, v) in res_headers.iter() {
        builder_headers.insert(k, v.clone());
    }
    for c in new_cookies {
        builder_headers.append(
            header::SET_COOKIE,
            HeaderValue::from_str(&c).unwrap_or(HeaderValue::from_static("")),
        );
    }

    builder.body(Body::from(final_body)).unwrap()
}

/**
Return final body, modified or not,
and a bool flag which indicates that returned body is rewritten to UTF-8 encoding
 */
async fn modify_content(
    state: &AppState,
    target_url: &Url,
    body: Bytes,
    is_html: bool,
    content_type: &str,
    is_debug_active: bool,
) -> (Bytes, bool) {
    if is_debug_active {
        println!("mc: Modifying content for {}", target_url);
    }

    if body.len() < 10 {
        return (body, false);
    }

    let mut charset = CHARSET_UTF8;
    if let Some(pos) = content_type.find("charset=") {
        let after = &content_type[pos + 8..];
        let end = after.find(';').unwrap_or(after.len());
        charset = &after[..end];
    }
    if is_html && charset == CHARSET_UTF8 {
        let prefix = &body[..std::cmp::min(body.len(), 4096)];
        let prefix_str = String::from_utf8_lossy(prefix);
        if let Some(caps) = META_CHARSET_REGEX.captures(&prefix_str) {
            if let Some(_) = caps.get(1) {
                // matched
            }
        }
    }

    let (cow, _, _) = if charset.contains("gbk") {
        encoding_rs::GBK.decode(&body)
    } else if charset.contains("windows-1251") || charset.contains("cp1251") {
        encoding_rs::WINDOWS_1251.decode(&body)
    } else if charset.contains("iso-8859-1") {
        encoding_rs::WINDOWS_1252.decode(&body)
    } else {
        encoding_rs::UTF_8.decode(&body)
    };

    let mut body_str = cow.to_string();

    let mut inject_html = format!(
        r#"<script>
        if (!window.__SITEPROXY_INJECTED) {{
            window.__SITEPROXY_PROXY_URL = "{}";
            window.__SITEPROXY_REAL_PROTOCOL = "{}";
            window.__SITEPROXY_REAL_HOST = "{}";
            window.__SITEPROXY_HIDE_TOP = "{}";
            window.__SITEPROXY_DEBUG = "{}";
        }} 
        </script>
        "#,
        state.proxy_url,
        target_url.scheme(),
        target_url.host_str().unwrap(),
        std::env::var("HIDE_TOP").ok().as_deref().unwrap_or(""),
        std::env::var("DEBUG").ok().as_deref().unwrap_or("")
    );

    if let Some(ref script) = state.script {
        let allow_script = state.script_domains.as_ref().map_or(true, |wl| {
            allow_domain(
                target_url.host_str().unwrap_or(""),
                &None,
                &Some(wl.clone()),
            )
        });
        if allow_script {
            let s_url = script
                .replace("{{domain}}", target_url.host_str().unwrap_or(""))
                .replace("{{ts}}", &chrono::Utc::now().timestamp_millis().to_string());
            inject_html.push_str(&format!(r#"<script src="{}"></script>"#, s_url));
        }
    }
    inject_html.push_str(&format!(r#"<script src="/{}inject.js"></script>"#, PREFIX));

    if !is_html {
        body_str = Regex::new(r"\bwindow\.location\s*=(.*?)")
            .unwrap()
            .replace_all(&body_str, "window.___location=$1")
            .to_string();
        body_str = Regex::new(r"\bwindow\.location\.href\s*=(.*?)")
            .unwrap()
            .replace_all(&body_str, "window.___location=$1")
            .to_string();
        body_str = Regex::new(r"\bwindow\.location\.assign\s*\((.*?)")
            .unwrap()
            .replace_all(&body_str, "window.___location.assign($1")
            .to_string();
    }

    for rule in BODY_MOD_RULES.iter() {
        if let Some(d) = &rule.domain {
            if !target_url.host_str().unwrap_or("").ends_with(d) {
                continue;
            }
        }
        body_str = rule
            .regex
            .replace_all(&body_str, &rule.replacement)
            .to_string();
    }

    if is_html {
        if body_str.contains("<head") {
            body_str = Regex::new(r"<head(.*?)>")
                .unwrap()
                .replace(&body_str, format!("<head$1>{}", inject_html))
                .to_string();
        } else if body_str.contains("<body") {
            body_str = Regex::new(r"<body(.*?)>")
                .unwrap()
                .replace(&body_str, format!("<body$1>{}", inject_html))
                .to_string();
        } else if body_str.contains("<html") {
            body_str = Regex::new(r"<html(.*?)>")
                .unwrap()
                .replace(&body_str, format!("<html$1>{}", inject_html))
                .to_string();
        } else {
            body_str.push_str(&inject_html);
        }
    }

    (Bytes::from(body_str), true)
}

#[tokio::main]
async fn main() {
    println!("siteproxy (rust backend) v{}", VERSION);
    tracing_subscriber::fmt::init();

    let port = std::env::var("PORT")
        .unwrap_or("5006".to_string())
        .parse()
        .unwrap_or(5006);
    let addr = std::env::var("ADDR").unwrap_or("0.0.0.0".to_string());
    let proxy_url_str = std::env::var("PROXY_URL").unwrap_or_else(|_| {
        if port != 80 {
            format!("http://localhost:{}/", port)
        } else {
            "http://localhost/".to_string()
        }
    });
    let mut proxy_url = Url::parse(&proxy_url_str).expect("Invalid PROXY_URL");

    proxy_url.set_fragment(None);
    proxy_url.set_query(None);
    proxy_url.set_username("").unwrap();
    proxy_url.set_password(None).unwrap();
    if !proxy_url.path().ends_with('/') {
        proxy_url.set_path(&format!("{}/", proxy_url.path()));
    }

    println!("Effective PROXY_URL: {}", proxy_url);

    let state = Arc::new(AppState {
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .http1_only() // some urls (like duckduckgo.com) fails if using http2
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap(),
        proxy_url,
        blacklist: str_to_set(std::env::var("BLACKLIST").ok()),
        whitelist: str_to_set(std::env::var("WHITELIST").ok()),
        script: std::env::var("SCRIPT").ok(),
        script_domains: str_to_set(std::env::var("SCRIPT_DOMAINS").ok()),
        debug: parse_debug_config(std::env::var("DEBUG").ok()),
    });

    let app = Router::new()
        .route(
            &format!("{}{}api", state.proxy_url.path(), PREFIX),
            get(api_handler),
        )
        .route("/robots.txt", get(serve_asset))
        .route(&format!("/{}inject.js", PREFIX), get(serve_asset))
        .route(&format!("/{}sw.js", PREFIX), get(serve_asset))
        // 1. Handle the root path (e.g., "http://localhost:5006/")
        .route(state.proxy_url.path(), get(serve_asset))
        // 2. Handle the explicit file name (e.g., "http://localhost:5006/__siteproxy_index.html")
        .route("/*path", any(proxy_handler))
        .fallback(any(proxy_handler))
        .layer(CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("{}:{}", addr, port))
        .await
        .unwrap();
    println!("Http server is listening on {} addr {} port", addr, port);
    axum::serve(listener, app).await.unwrap();
}
