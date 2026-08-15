//! M7 博客发布：frontmatter 解析、站点生成（Zola 兼容源 + 内置 SSG 渲染）、内置预览服务器。
//!
//! - 笔记顶部 `--- key: value ---` 声明元数据（title / date / tags / status）
//! - status=published 的笔记参与站点生成
//! - 生成 `vault/site/`：content/（Zola 兼容源）+ config.toml + public/（可直接部署的 HTML 站）
//! - blog_preview_start 起 tiny_http 静态服务器预览 public/

use crate::core::path::resolve_safe;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/* ---------------- 数据模型 ---------------- */

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PostMeta {
    pub path: String,
    pub title: String,
    pub date: String,
    pub tags: Vec<String>,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlogListResult {
    pub posts: Vec<PostMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlogGenerateResult {
    pub site_dir: String,
    pub posts: usize,
}

/* ---------------- frontmatter ---------------- */

pub fn parse_frontmatter(content: &str) -> (BTreeMap<String, String>, String) {
    let body = content.strip_prefix('\u{feff}').unwrap_or(content);
    if !body.starts_with("---") {
        return (BTreeMap::new(), content.to_string());
    }
    let rest = &body[3..];
    let Some(end) = rest.find("\n---") else {
        return (BTreeMap::new(), content.to_string());
    };
    let fm_raw = &rest[..end];
    let body_text = &rest[end + 4..];
    let mut map = BTreeMap::new();
    for line in fm_raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    (map, body_text.trim_start_matches('\n').to_string())
}

fn meta_from(path: &str, fm: &BTreeMap<String, String>) -> PostMeta {
    PostMeta {
        path: path.to_string(),
        title: fm.get("title").cloned().unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        }),
        date: fm.get("date").cloned().unwrap_or_default(),
        tags: fm
            .get("tags")
            .map(|t| {
                t.split([',', '，'])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        status: fm.get("status").cloned().unwrap_or_else(|| "draft".into()),
    }
}

fn is_published(fm: &BTreeMap<String, String>) -> bool {
    match fm.get("status").map(|s| s.as_str()) {
        Some("published") => true,
        Some("publish") => true,
        _ => fm.get("publish").map(|v| v == "true").unwrap_or(false),
    }
}

/* ---------------- 扫描 ---------------- */

fn collect_md(root: &Path, dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "site" {
            continue;
        }
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            collect_md(root, &entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            out.push((rel, entry.path()));
        }
    }
}

fn scan_posts(vault: &str) -> Vec<PostMeta> {
    // 博客文章来自笔记目录（vault/notes/），不扫描 data/plugins 等其他目录
    let root = PathBuf::from(vault).join("notes");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    // base 传 "notes"，返回的 rel 带前缀，与 fs_read/前端路径保持一致
    collect_md(&root, &root, "notes", &mut files);
    let mut posts = Vec::new();
    for (rel, abs) in files {
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let (fm, _) = parse_frontmatter(&content);
        posts.push(meta_from(&rel, &fm));
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date));
    posts
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub async fn blog_list(vault: String) -> BlogListResult {
    BlogListResult { posts: scan_posts(&vault) }
}

/// 生成站点到 vault/site/（Zola 兼容 content/ + 渲染后的 public/）。
#[tauri::command]
pub async fn blog_generate(vault: String, site_title: String) -> Result<BlogGenerateResult, String> {
    let site_dir = PathBuf::from(&vault).join("site");
    let content_dir = site_dir.join("content");
    let public_dir = site_dir.join("public");
    let public_posts = public_dir.join("posts");

    // 重新生成前清理旧输出（content/ 与 public/ 全量重建，保证与当前发布集合一致）
    for dir in [&content_dir, &public_dir] {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| format!("清理旧输出失败: {e}"))?;
        }
    }
    std::fs::create_dir_all(&content_dir)
        .and_then(|_| std::fs::create_dir_all(&public_posts))
        .map_err(|e| format!("创建站点目录失败: {e}"))?;

    let posts = scan_posts(&vault);
    let published: Vec<PostMeta> = {
        let mut out = Vec::new();
        for p in &posts {
            let abs = resolve_safe(&vault, &p.path)?;
            let Ok(content) = std::fs::read_to_string(&abs) else {
                continue;
            };
            let (fm, _) = parse_frontmatter(&content);
            if is_published(&fm) {
                out.push(p.clone());
            }
        }
        out
    };

    let title = if site_title.trim().is_empty() {
        "ToolBox 博客".to_string()
    } else {
        site_title.trim().to_string()
    };

    // config.toml（Zola 兼容；title 转义双引号与反斜杠）
    let esc_title = title.replace('\\', "\\\\").replace('"', "\\\"");
    std::fs::write(
        site_dir.join("config.toml"),
        format!(
            "# 由 ToolBox 生成（Zola 兼容）\ntitle = \"{esc_title}\"\nbase_url = \"/\"\n"
        ),
    )
    .map_err(|e| format!("写 config 失败: {e}"))?;

    // style.css（public/ 供预览服务器与部署；static/ 供 Zola 兼容）
    write_css(&public_dir.join("style.css"))?;
    write_css(&site_dir.join("static").join("style.css"))?;

    // 文章页 + content 源
    let mut cards = String::new();
    let mut slug_used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for p in &published {
        let abs = resolve_safe(&vault, &p.path)?;
        let raw = std::fs::read_to_string(&abs)
            .map_err(|e| format!("读 {} 失败: {e}", p.path))?;
        let (_, body) = parse_frontmatter(&raw);
        // slug 去重：同标题文章追加序号
        let mut slug = slugify(&p.title);
        let mut n = 2;
        while !slug_used.insert(slug.clone()) {
            slug = format!("{}-{n}", slugify(&p.title));
            n += 1;
        }
        let date = if p.date.is_empty() {
            "无日期".to_string()
        } else {
            escape(&p.date)
        };
        let tags_html = p
            .tags
            .iter()
            .map(|t| format!("<span class=\"tag\">{}</span>", escape(t)))
            .collect::<String>();

        // content/ 源：直接写原始文件（frontmatter + 正文完整保留，避免拼接损坏）
        std::fs::write(content_dir.join(format!("{slug}.md")), &raw)
            .map_err(|e| format!("写 content 失败: {e}"))?;

        // public/posts/<slug>.html
        let html = render_md(&body);
        let page = format!(
            "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>{}</title>\
             <link rel=\"stylesheet\" href=\"/style.css\"></head><body>\
             <header class=\"site-head\"><a class=\"home\" href=\"/\">{}</a></header>\
             <article class=\"post\"><h1>{}</h1><div class=\"post-meta\">{} · {}</div>\
             <div class=\"post-body\">{}</div></article>\
             <footer class=\"site-foot\">由 ToolBox 生成</footer></body></html>",
            escape(&p.title),
            escape(&title),
            escape(&p.title),
            date,
            tags_html,
            html
        );
        std::fs::write(public_posts.join(format!("{slug}.html")), page)
            .map_err(|e| format!("写文章页失败: {e}"))?;

        cards.push_str(&format!(
            "<a class=\"card\" href=\"/posts/{slug}.html\">\
             <h2>{}</h2><div class=\"card-meta\">{} {}</div></a>",
            escape(&p.title),
            date,
            tags_html
        ));
    }

    // index.html
    let index = format!(
        "<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>{}</title>\
         <link rel=\"stylesheet\" href=\"/style.css\"></head><body>\
         <header class=\"site-head\"><span class=\"site-title\">{}</span></header>\
         <main class=\"cards\">{}</main>\
         <footer class=\"site-foot\">共 {} 篇 · 由 ToolBox 生成</footer></body></html>",
        escape(&title),
        escape(&title),
        cards,
        published.len()
    );
    std::fs::write(public_dir.join("index.html"), index)
        .map_err(|e| format!("写首页失败: {e}"))?;

    Ok(BlogGenerateResult {
        site_dir: site_dir.to_string_lossy().to_string(),
        posts: published.len(),
    })
}

fn slugify(title: &str) -> String {
    let mut slug: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "post".to_string()
    } else {
        slug.to_string()
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_md(md: &str) -> String {
    let parser = pulldown_cmark::Parser::new(md);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

fn write_css(path: &Path) -> Result<(), String> {
    let css = r#"body{max-width:820px;margin:0 auto;padding:24px 20px 80px;font-family:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif;color:#201f1c;background:#f6f5f2;line-height:1.75}
.site-head{display:flex;align-items:baseline;gap:12px;padding:12px 0 24px;border-bottom:1px solid #e7e4dd}
.site-title{font-size:22px;font-weight:700;letter-spacing:-.02em}
.home{color:#b4532a;text-decoration:none;font-size:15px}
.cards{display:flex;flex-direction:column;gap:14px;margin-top:24px}
.card{display:block;padding:18px 20px;border:1px solid #e7e4dd;border-radius:10px;background:#fff;text-decoration:none;color:inherit;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 10px rgba(32,31,28,.08)}
.card h2{margin:0 0 6px;font-size:17px}
.card-meta{font-size:12px;color:#787774}
.tag{display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:#f3e5da;color:#93401f;font-size:11px}
.post{margin-top:28px}
.post h1{font-size:26px;letter-spacing:-.02em;margin-bottom:8px}
.post-meta{font-size:13px;color:#787774;margin-bottom:24px}
.post-body{font-size:15.5px}
.post-body h2{border-bottom:1px solid #e7e4dd;padding-bottom:6px}
.post-body pre{background:#fbfbfa;border:1px solid #e7e4dd;border-radius:8px;padding:14px;overflow:auto}
.post-body code{background:#fbfbfa;padding:1px 5px;border-radius:4px;font-size:.92em}
.post-body pre code{background:none;padding:0}
.post-body blockquote{margin:0;padding:2px 16px;border-left:3px solid #d6d2c8;color:#787774;background:#fbfbfa}
.site-foot{margin-top:56px;padding-top:16px;border-top:1px solid #e7e4dd;color:#a8a49e;font-size:12px}
"#;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(path, css).map_err(|e| format!("写 css 失败: {e}"))
}

/* ---------------- 预览服务器 ---------------- */

use std::sync::atomic::{AtomicU16, Ordering};

static PREVIEW_PORT: AtomicU16 = AtomicU16::new(0);

pub struct PreviewState {
    pub server: Mutex<Option<Arc<tiny_http::Server>>>,
    pub vault: Mutex<Option<PathBuf>>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            vault: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub async fn blog_preview_start(
    state: State<'_, PreviewState>,
    vault: String,
) -> Result<String, String> {
    let port_of = |s: &tiny_http::Server| -> u16 {
        s.server_addr().to_ip().map(|a| a.port()).unwrap_or(0)
    };
    // 已在运行：仅当属于同一 vault 时复用，否则先停掉再按当前 vault 重启
    let same_vault = {
        let cur = state.vault.lock().map_err(|e| e.to_string())?;
        cur.as_ref().map(|p| p == Path::new(&vault)).unwrap_or(false)
    };
    if let Some(s) = state.server.lock().map_err(|e| e.to_string())?.as_ref() {
        if same_vault {
            return Ok(format!("http://127.0.0.1:{}/", port_of(s)));
        }
        // 不同 vault：停掉旧服务
        if let Some(old) = state.server.lock().map_err(|e| e.to_string())?.take() {
            old.unblock();
        }
        PREVIEW_PORT.store(0, Ordering::Relaxed);
    }
    let public_dir = PathBuf::from(&vault).join("site").join("public");
    if !public_dir.join("index.html").exists() {
        return Err("尚未生成站点 —— 请先在博客页点击「生成站点」".to_string());
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("启动服务器失败: {e}"))?;
    let port = port_of(&server);
    PREVIEW_PORT.store(port, Ordering::Relaxed);

    let server = Arc::new(server);
    let handle = server.clone();
    let dir = public_dir.clone();
    std::thread::spawn(move || {
        for request in handle.incoming_requests() {
            let path = request.url().to_string();
            let file_path = resolve_static(&dir, &path);
            match file_path {
                Some(fp) => {
                    if let Ok(content) = std::fs::read(&fp) {
                        let mime = mime_of(&fp);
                        let _ = request.respond(
                            tiny_http::Response::from_data(content)
                                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap()),
                        );
                    } else {
                        let _ = request.respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
                    }
                }
                None => {
                    let _ = request.respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
                }
            }
        }
    });

    *state.server.lock().map_err(|e| e.to_string())? = Some(server);
    *state.vault.lock().map_err(|e| e.to_string())? = Some(PathBuf::from(&vault));
    Ok(format!("http://127.0.0.1:{port}/"))
}

#[tauri::command]
pub async fn blog_preview_stop(state: State<'_, PreviewState>) -> Result<(), String> {
    if let Some(s) = state.server.lock().map_err(|e| e.to_string())?.take() {
        s.unblock();
    }
    *state.vault.lock().map_err(|e| e.to_string())? = None;
    PREVIEW_PORT.store(0, Ordering::Relaxed);
    Ok(())
}

fn resolve_static(root: &Path, url_path: &str) -> Option<PathBuf> {
    let raw = url_path.split('?').next().unwrap_or("/").trim_start_matches('/');
    let clean = percent_decode(raw);
    let rel = if clean.is_empty() { "index.html".to_string() } else { clean };
    let p = root.join(rel);
    if !p.starts_with(root) || p.is_dir() {
        return None;
    }
    if p.extension().is_none() {
        return Some(p.join("index.html"));
    }
    Some(p)
}

/// 简单百分号解码（UTF-8 路径，如 posts/%E7%AC%AC...）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) =
                ((bytes[i + 1] as char).to_digit(16), (bytes[i + 2] as char).to_digit(16))
            {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_of(p: &Path) -> String {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8".into(),
        "css" => "text/css; charset=utf-8".into(),
        "js" => "application/javascript".into(),
        "json" => "application/json".into(),
        "svg" => "image/svg+xml".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "ico" => "image/x-icon".into(),
        "md" => "text/plain; charset=utf-8".into(),
        _ => "application/octet-stream".into(),
    }
}

/* ---------------- 打开站点目录 ---------------- */

#[tauri::command]
pub async fn blog_open_folder(vault: String) -> Result<(), String> {
    let site = PathBuf::from(&vault).join("site");
    if !site.exists() {
        return Err("站点目录不存在 —— 请先生成站点".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&site)
            .spawn()
            .map_err(|e| format!("打开站点目录失败: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = site;
        return Err("当前平台暂不支持".to_string());
    }
    Ok(())
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_parse() {
        let content = "---\ntitle: 你好\nstatus: published\ntags: 工作, 随笔\ndate: 2026-08-01\n---\n\n正文内容";
        let (fm, body) = parse_frontmatter(content);
        assert_eq!(fm.get("title").unwrap(), "你好");
        assert!(is_published(&fm));
        assert_eq!(body.trim(), "正文内容");
        let meta = meta_from("notes/你好.md", &fm);
        assert_eq!(meta.tags, vec!["工作", "随笔"]);
    }

    #[test]
    fn frontmatter_absent() {
        let (fm, body) = parse_frontmatter("# 无 frontmatter\n\n内容");
        assert!(fm.is_empty());
        assert!(body.contains("无 frontmatter"));
    }

    #[test]
    fn slug() {
        assert_eq!(slugify("你好 世界!!"), "你好-世界");
        assert_eq!(slugify("a--b---c"), "a-b-c");
    }

    /// 生成站点：content/ 源应与原文一致（不重复正文），public/ 正常渲染。
    #[test]
    fn generate_content_matches_source() {
        let tmp = std::env::temp_dir().join(format!("toolbox-blog-test-{}", std::process::id()));
        let notes = tmp.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let note = "---\ntitle: 测试文章\nstatus: published\ntags: 测试\n---\n\n正文内容 **加粗**。\n";
        std::fs::write(notes.join("a.md"), note).unwrap();

        let res = tauri::async_runtime::block_on(blog_generate(
            tmp.to_string_lossy().to_string(),
            "测试站".into(),
        ))
        .unwrap();
        assert_eq!(res.posts, 1);

        let content_src =
            std::fs::read_to_string(tmp.join("site/content/测试文章.md")).unwrap();
        // 与原文一致：正文只出现一次，无多余 --- 分隔
        assert_eq!(content_src, note);
        assert_eq!(content_src.matches("正文内容").count(), 1);

        let idx = std::fs::read_to_string(tmp.join("site/public/index.html")).unwrap();
        assert!(idx.contains("测试文章"));

        let post =
            std::fs::read_to_string(tmp.join("site/public/posts/测试文章.html")).unwrap();
        assert!(post.contains("<strong>加粗</strong>"), "markdown 渲染: {post}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 重新生成清理旧输出 + 同标题 slug 去重。
    #[test]
    fn regenerate_cleans_and_dedups_slug() {
        let tmp = std::env::temp_dir().join(format!("toolbox-blog-test2-{}", std::process::id()));
        let notes = tmp.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let mk = |name: &str| {
            std::fs::write(
                notes.join(format!("{name}.md")),
                format!(
                    "---\ntitle: 同名\ndate: 2026-08-01\nstatus: published\n---\n\n正文 {name}\n"
                ),
            )
            .unwrap();
        };
        mk("a");
        mk("b");
        let res1 = tauri::async_runtime::block_on(blog_generate(
            tmp.to_string_lossy().to_string(),
            "站".into(),
        ))
        .unwrap();
        eprintln!("[dbg] posts count: {}", res1.posts);
        // 两篇同名文章 → 两个不同 slug 文件
        let posts_dir = tmp.join("site/public/posts");
        let files: Vec<_> = std::fs::read_dir(&posts_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 2, "slug 去重失败: {files:?}");

        // 重新生成（改一篇为草稿）→ 旧文章被清理
        std::fs::write(
            notes.join("a.md"),
            "---\ntitle: 同名\nstatus: draft\n---\n\n正文 a\n",
        )
        .unwrap();
        let res = tauri::async_runtime::block_on(blog_generate(
            tmp.to_string_lossy().to_string(),
            "站".into(),
        ))
        .unwrap();
        assert_eq!(res.posts, 1);
        let files2: Vec<_> = std::fs::read_dir(&posts_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files2.len(), 1, "旧输出未清理: {files2:?}");

        std::fs::remove_dir_all(&tmp).ok();
    }
}
