use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortService {
    port: u16,
    protocol: String,
    pid: u32,
    process_name: String,
    display_name: String,
    source: Option<ServiceSource>,
    command: Option<String>,
    cwd: Option<String>,
    folder_group: Option<String>,
    address: Option<String>,
    owner_matches_current_user: bool,
    can_kill: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServiceSource {
    Docker,
    Application,
}

#[derive(Debug, Clone)]
struct Listener {
    port: u16,
    protocol: String,
    pid: u32,
    process_name: String,
    address: Option<String>,
    owner_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityScan {
    port: u16,
    status: CapabilityStatus,
    base_url: Option<String>,
    docs_url: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CapabilityStatus {
    Web,
    ApiDocs,
    Grpc,
    ApiNoDocs,
    Unknown,
    Error,
}

#[derive(Debug)]
struct HttpProbe {
    status: u16,
    content_type: Option<String>,
    location: Option<String>,
    final_path: String,
    body: String,
}

#[derive(Debug, Clone)]
struct DockerService {
    name: String,
    group: String,
}

#[derive(Debug, Deserialize)]
struct DockerContainer {
    #[serde(rename = "Labels")]
    labels: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Networks")]
    networks: String,
    #[serde(rename = "Ports")]
    ports: String,
}

#[tauri::command]
async fn scan_ports() -> Result<Vec<PortService>, String> {
    tauri::async_runtime::spawn_blocking(scan_ports_blocking)
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn scan_capabilities(port: u16, address: Option<String>) -> Result<CapabilityScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_capabilities_blocking(port, address))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    open_target(&url)
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    let folder = PathBuf::from(path);
    if !folder.is_dir() {
        return Err("Folder is not available".into());
    }
    open_target(path_to_str(&folder)?)
}

#[tauri::command]
async fn open_terminal(path: String) -> Result<(), String> {
    let folder = PathBuf::from(path);
    if !folder.is_dir() {
        return Err("Folder is not available".into());
    }

    #[cfg(target_os = "macos")]
    {
        run_command("open", &["-a", "Terminal", path_to_str(&folder)?])
    }

    #[cfg(target_os = "linux")]
    {
        let folder_str = path_to_str(&folder)?;
        let attempts: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["--working-directory", folder_str]),
            ("gnome-terminal", &["--working-directory", folder_str]),
            ("konsole", &["--workdir", folder_str]),
            ("xfce4-terminal", &["--working-directory", folder_str]),
        ];
        run_first_available(attempts)
    }

    #[cfg(target_os = "windows")]
    {
        run_command(
            "cmd",
            &["/C", "start", "", "wt", "-d", path_to_str(&folder)?],
        )
    }
}

#[tauri::command]
async fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        run_command("kill", &["-TERM", &pid.to_string()])
    }

    #[cfg(target_os = "windows")]
    {
        run_command("taskkill", &["/PID", &pid.to_string()])
    }
}

fn scan_ports_blocking() -> Result<Vec<PortService>, String> {
    let listeners = list_listeners()?;
    let docker_services = docker_services_by_port();
    let current_owner = current_owner_id();
    let mut seen = HashSet::new();
    let mut services = Vec::new();

    for listener in listeners {
        let key = (listener.pid, listener.port, listener.address.clone());
        if !seen.insert(key) {
            continue;
        }

        let cwd = process_cwd(listener.pid).and_then(|path| normalize_path(path).ok());
        let command = process_command(listener.pid);
        let app_name = app_bundle_name(cwd.as_deref(), command.as_deref());
        let docker_service = docker_services.get(&listener.port);
        let source = if docker_service.is_some() {
            Some(ServiceSource::Docker)
        } else if app_name.is_some() {
            Some(ServiceSource::Application)
        } else {
            None
        };
        let display_name = docker_service
            .map(|service| service.name.clone())
            .or_else(|| app_name.clone())
            .unwrap_or_else(|| listener.process_name.clone());
        let folder_group = if let Some(service) = docker_service {
            Some(format!("Docker/{}", service.group))
        } else if let Some(app_path) = app_bundle_path(cwd.as_deref(), command.as_deref()) {
            Some(app_path)
        } else {
            cwd.as_deref()
                .and_then(|path| nearest_git_group(Path::new(path)))
                .or_else(|| cwd.clone())
        };
        let owner_matches_current_user = match (&listener.owner_id, &current_owner) {
            (Some(owner), Some(current)) => owner == current,
            _ => false,
        };

        services.push(PortService {
            port: listener.port,
            protocol: listener.protocol,
            pid: listener.pid,
            process_name: listener.process_name,
            display_name,
            source,
            command,
            cwd,
            folder_group,
            address: listener.address,
            owner_matches_current_user,
            can_kill: owner_matches_current_user && docker_service.is_none(),
        });
    }

    services.sort_by(|left, right| {
        left.folder_group
            .cmp(&right.folder_group)
            .then(left.port.cmp(&right.port))
            .then(left.pid.cmp(&right.pid))
    });
    Ok(services)
}

fn scan_capabilities_blocking(
    port: u16,
    address: Option<String>,
) -> Result<CapabilityScan, String> {
    let docs_paths = [
        "/swagger-ui",
        "/swagger-ui/",
        "/swagger-ui/index.html",
        "/swagger",
        "/swagger/",
        "/api-docs",
        "/docs",
        "/docs/",
        "/openapi.json",
        "/swagger.json",
    ];

    let hosts = probe_hosts(address.as_deref());
    let mut last_error = None;

    for host in hosts {
        let base_url = format!("http://{}:{port}", url_host(&host));
        if probe_grpc_h2c(&host, port).is_ok() {
            return Ok(CapabilityScan {
                port,
                status: CapabilityStatus::Grpc,
                base_url: None,
                docs_url: None,
                detail: Some(format!(
                    "HTTP/2 gRPC endpoint detected on {}",
                    url_host(&host)
                )),
            });
        }

        let root_probe = match probe_http_follow_redirects(&host, port, "/") {
            Ok(probe) => Some(probe),
            Err(err) => {
                last_error = Some(err);
                None
            }
        };

        if root_probe.is_none() {
            continue;
        }

        for path in docs_paths {
            if let Ok(probe) = probe_http_follow_redirects(&host, port, path) {
                if is_success(probe.status)
                    && (looks_like_html(&probe) || looks_like_openapi(&probe))
                {
                    return Ok(CapabilityScan {
                        port,
                        status: CapabilityStatus::ApiDocs,
                        base_url: Some(base_url),
                        docs_url: Some(format!(
                            "http://{}:{port}{}",
                            url_host(&host),
                            probe.final_path
                        )),
                        detail: Some(format!("Found docs at {path}")),
                    });
                }
            }
        }

        if let Some(probe) = root_probe {
            if is_success(probe.status) && looks_like_html(&probe) {
                return Ok(CapabilityScan {
                    port,
                    status: CapabilityStatus::Web,
                    base_url: Some(format!(
                        "http://{}:{port}{}",
                        url_host(&host),
                        probe.final_path
                    )),
                    docs_url: None,
                    detail: Some(format!("HTML page detected at {}", probe.final_path)),
                });
            }

            if is_success(probe.status) {
                return Ok(CapabilityScan {
                    port,
                    status: CapabilityStatus::ApiNoDocs,
                    base_url: Some(base_url),
                    docs_url: None,
                    detail: Some("HTTP service responded, but no API docs were found".into()),
                });
            }
        }
    }

    let fallback_host = probe_hosts(address.as_deref())
        .into_iter()
        .next()
        .unwrap_or_else(|| "127.0.0.1".into());
    Ok(CapabilityScan {
        port,
        status: if last_error.is_some() {
            CapabilityStatus::Error
        } else {
            CapabilityStatus::Unknown
        },
        base_url: Some(format!("http://{}:{port}", url_host(&fallback_host))),
        docs_url: None,
        detail: Some(last_error.unwrap_or_else(|| "No HTTP capability detected".into())),
    })
}

fn probe_grpc_h2c(host: &str, port: u16) -> Result<(), String> {
    let addr: SocketAddr = socket_addr(host, port)?
        .parse()
        .map_err(|err| format!("Invalid address: {err}"))?;
    let timeout = Duration::from_millis(500);
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|err| format!("Connection failed: {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    // HTTP/2 client connection preface followed by an empty SETTINGS frame.
    let mut preface = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
    preface.extend_from_slice(&[0, 0, 0, 0x04, 0, 0, 0, 0, 0]);
    stream
        .write_all(&preface)
        .map_err(|err| format!("HTTP/2 preface failed: {err}"))?;

    let mut frame_header = [0; 9];
    stream
        .read_exact(&mut frame_header)
        .map_err(|err| format!("HTTP/2 response failed: {err}"))?;

    if frame_header[3] == 0x04 {
        Ok(())
    } else {
        Err("No HTTP/2 SETTINGS frame received".into())
    }
}

fn probe_http_follow_redirects(host: &str, port: u16, path: &str) -> Result<HttpProbe, String> {
    let mut current_path = normalize_http_path(path);
    for _ in 0..4 {
        let probe = probe_http(host, port, &current_path)?;
        if !is_redirect(probe.status) {
            return Ok(probe);
        }

        let Some(location) = probe.location.clone() else {
            return Ok(probe);
        };
        let Some(next_path) = redirect_path(&location) else {
            return Ok(probe);
        };
        if next_path == current_path {
            return Ok(probe);
        }
        current_path = next_path;
    }

    probe_http(host, port, &current_path)
}

fn probe_http(host: &str, port: u16, path: &str) -> Result<HttpProbe, String> {
    let addr: SocketAddr = socket_addr(host, port)?
        .parse()
        .map_err(|err| format!("Invalid address: {err}"))?;
    let timeout = Duration::from_millis(850);
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|err| format!("Connection failed: {err}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| err.to_string())?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {}:{port}\r\nUser-Agent: Porthole/0.1\r\nAccept: text/html,application/json,*/*\r\nConnection: close\r\n\r\n",
        url_host(host)
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("Request failed: {err}"))?;

    let mut response = Vec::new();
    let mut buffer = [0; 4096];
    while response.len() < 128 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes) => response.extend_from_slice(&buffer[..bytes]),
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(err) => return Err(format!("Response failed: {err}")),
        }
    }

    let text = String::from_utf8_lossy(&response).to_string();
    let mut probe = parse_http_response(&text)?;
    probe.final_path = normalize_http_path(path);
    Ok(probe)
}

fn parse_http_response(response: &str) -> Result<HttpProbe, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid HTTP response".to_string())?;
    let mut lines = headers.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP status".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Invalid HTTP status".to_string())?;
    let mut content_type = None;
    let mut location = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-type") {
                content_type = Some(value.trim().to_ascii_lowercase());
            } else if name.eq_ignore_ascii_case("location") {
                location = Some(value.trim().to_string());
            }
        }
    }

    Ok(HttpProbe {
        status,
        content_type,
        location,
        final_path: "/".into(),
        body: body.to_string(),
    })
}

fn is_success(status: u16) -> bool {
    (200..400).contains(&status)
}

fn is_redirect(status: u16) -> bool {
    (300..400).contains(&status)
}

fn normalize_http_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

fn redirect_path(location: &str) -> Option<String> {
    if location.starts_with('/') {
        return Some(normalize_http_path(location));
    }

    let marker = "://";
    let (_, rest) = location.split_once(marker)?;
    let path_start = rest.find('/')?;
    Some(normalize_http_path(&rest[path_start..]))
}

fn looks_like_html(probe: &HttpProbe) -> bool {
    probe
        .content_type
        .as_deref()
        .is_some_and(|value| value.contains("text/html"))
        || probe.body.to_ascii_lowercase().contains("<html")
        || probe.body.to_ascii_lowercase().contains("<!doctype html")
}

fn looks_like_openapi(probe: &HttpProbe) -> bool {
    let body = probe.body.to_ascii_lowercase();
    body.contains("\"openapi\"")
        || body.contains("\"swagger\"")
        || body.contains("swagger-ui")
        || body.contains("redoc")
}

#[cfg(target_os = "macos")]
fn list_listeners() -> Result<Vec<Listener>, String> {
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcun"])
        .output()
        .map_err(|err| format!("Failed to run lsof: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let mut pid = None;
    let mut process_name = None;
    let mut owner_id = None;
    let mut listeners = Vec::new();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
            process_name = None;
            owner_id = None;
        } else if let Some(value) = line.strip_prefix('c') {
            process_name = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix('u') {
            owner_id = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix('n') {
            if let (Some(pid), Some(port)) = (pid, parse_port(value)) {
                listeners.push(Listener {
                    port,
                    protocol: "tcp".into(),
                    pid,
                    process_name: process_name.clone().unwrap_or_else(|| format!("pid-{pid}")),
                    address: Some(value.to_string()),
                    owner_id: owner_id.clone(),
                });
            }
        }
    }

    Ok(listeners)
}

#[cfg(target_os = "linux")]
fn list_listeners() -> Result<Vec<Listener>, String> {
    let output = Command::new("ss")
        .args(["-ltnpH"])
        .output()
        .map_err(|err| format!("Failed to run ss: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let mut listeners = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }
        let address = fields[3];
        let Some(port) = parse_port(address) else {
            continue;
        };
        let details = fields.get(5).copied().unwrap_or_default();
        let Some(pid) = parse_between(details, "pid=", ",").and_then(|value| value.parse().ok())
        else {
            continue;
        };
        let process_name =
            parse_between(details, "(\"", "\"").unwrap_or_else(|| format!("pid-{pid}"));

        listeners.push(Listener {
            port,
            protocol: "tcp".into(),
            pid,
            process_name,
            address: Some(address.to_string()),
            owner_id: process_owner_id(pid),
        });
    }

    Ok(listeners)
}

#[cfg(target_os = "windows")]
fn list_listeners() -> Result<Vec<Listener>, String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|err| format!("Failed to run netstat: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let mut listeners = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || fields[0] != "TCP" || fields[3] != "LISTENING" {
            continue;
        }
        let Some(port) = parse_port(fields[1]) else {
            continue;
        };
        let Some(pid) = fields[4].parse::<u32>().ok() else {
            continue;
        };
        listeners.push(Listener {
            port,
            protocol: "tcp".into(),
            pid,
            process_name: windows_process_name(pid).unwrap_or_else(|| format!("pid-{pid}")),
            address: Some(fields[1].to_string()),
            owner_id: None,
        });
    }
    Ok(listeners)
}

fn docker_services_by_port() -> HashMap<u16, DockerService> {
    let output = Command::new("docker")
        .args(["ps", "--format", "{{json .}}"])
        .output();
    let Ok(output) = output else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }

    let mut services = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(container) = serde_json::from_str::<DockerContainer>(line) else {
            continue;
        };
        let group = docker_group_name(&container);
        for port in parse_docker_host_ports(&container.ports) {
            services.entry(port).or_insert_with(|| DockerService {
                name: container.names.clone(),
                group: group.clone(),
            });
        }
    }

    services
}

fn docker_group_name(container: &DockerContainer) -> String {
    let labels = parse_docker_labels(&container.labels);
    labels
        .get("com.docker.compose.project")
        .map(|project| format!("Compose: {project}"))
        .or_else(|| {
            first_csv_value(&container.networks).map(|network| format!("Network: {network}"))
        })
        .unwrap_or_else(|| "Ungrouped".into())
}

fn parse_docker_labels(labels: &str) -> HashMap<String, String> {
    labels
        .split(',')
        .filter_map(|label| {
            let (key, value) = label.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn first_csv_value(value: &str) -> Option<String> {
    value
        .split(',')
        .map(str::trim)
        .find(|part| !part.is_empty())
        .map(ToString::to_string)
}

fn parse_docker_host_ports(ports: &str) -> Vec<u16> {
    ports
        .split(',')
        .flat_map(|part| {
            let mapping = part.trim();
            let Some((host, _)) = mapping.split_once("->") else {
                return Vec::new();
            };
            parse_port_range(host)
        })
        .collect()
}

fn parse_port(address: &str) -> Option<u16> {
    parse_port_range(address).into_iter().next()
}

fn parse_port_range(address: &str) -> Vec<u16> {
    let without_suffix = address.split("->").next().unwrap_or(address);
    let Some((_, port)) = without_suffix.rsplit_once(':') else {
        return Vec::new();
    };
    let port = port.trim_end_matches(')');
    if let Some((start, end)) = port.split_once('-') {
        let (Ok(start), Ok(end)) = (start.parse::<u16>(), end.parse::<u16>()) else {
            return Vec::new();
        };
        return (start..=end).collect();
    }
    port.parse().map(|port| vec![port]).unwrap_or_default()
}

fn probe_hosts(address: Option<&str>) -> Vec<String> {
    let mut hosts = Vec::new();
    if let Some(address) = address.and_then(listener_host) {
        if address == "*" || address == "0.0.0.0" {
            hosts.extend(["127.0.0.1".to_string(), "::1".to_string()]);
        } else if address == "::" {
            hosts.extend(["::1".to_string(), "127.0.0.1".to_string()]);
        } else {
            hosts.push(address);
        }
    }

    if hosts.is_empty() {
        hosts.extend(["127.0.0.1".to_string(), "::1".to_string()]);
    }

    hosts.dedup();
    hosts
}

fn listener_host(address: &str) -> Option<String> {
    let address = address.split("->").next().unwrap_or(address).trim();
    if let Some(rest) = address.strip_prefix('[') {
        let (host, _) = rest.split_once("]:")?;
        return Some(host.to_string());
    }
    address
        .rsplit_once(':')
        .map(|(host, _)| host.to_string())
        .filter(|host| !host.is_empty())
}

fn socket_addr(host: &str, port: u16) -> Result<String, String> {
    if host.contains(':') {
        Ok(format!("[{host}]:{port}"))
    } else {
        Ok(format!("{host}:{port}"))
    }
}

fn url_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn app_bundle_name(cwd: Option<&str>, command: Option<&str>) -> Option<String> {
    app_bundle_path(cwd, command)
        .as_deref()
        .and_then(|path| final_path_segment(path))
        .map(|name| name.trim_end_matches(".app").to_string())
        .filter(|name| !name.is_empty())
}

fn app_bundle_path(cwd: Option<&str>, command: Option<&str>) -> Option<String> {
    cwd.and_then(extract_app_bundle_path)
        .or_else(|| command.and_then(extract_app_bundle_path))
}

fn extract_app_bundle_path(value: &str) -> Option<String> {
    let marker = ".app";
    let end = value.find(marker)? + marker.len();
    let prefix = &value[..end];
    let start = prefix
        .rfind("/Applications/")
        .or_else(|| prefix.rfind("/System/Applications/"))
        .or_else(|| prefix.rfind("/System/Library/CoreServices/"))?;
    Some(prefix[start..].to_string())
}

fn final_path_segment(path: &str) -> Option<&str> {
    path.split(['/', '\\']).rfind(|part| !part.is_empty())
}

fn nearest_git_group(cwd: &Path) -> Option<String> {
    let mut candidate = if cwd.is_file() {
        cwd.parent()?.to_path_buf()
    } else {
        cwd.to_path_buf()
    };

    loop {
        if candidate.join(".git").exists() {
            return normalize_path(candidate).ok();
        }
        if !candidate.pop() {
            return None;
        }
    }
}

fn normalize_path(path: PathBuf) -> Result<String, String> {
    let normalized = fs::canonicalize(&path).unwrap_or(path);
    Ok(normalized.to_string_lossy().to_string())
}

fn path_to_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "Path contains unsupported characters".to_string())
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    let output = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').map(PathBuf::from))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "windows")]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "linux")]
fn process_owner_id(pid: u32) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(format!("/proc/{pid}"))
        .ok()
        .map(|metadata| metadata.uid().to_string())
}

#[cfg(not(unix))]
fn process_owner_id(_pid: u32) -> Option<String> {
    None
}

#[cfg(unix)]
fn current_owner_id() -> Option<String> {
    let output = Command::new("id").arg("-u").output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

#[cfg(not(unix))]
fn current_owner_id() -> Option<String> {
    None
}

#[cfg(unix)]
fn process_command(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let value = fs::read_to_string(format!("/proc/{pid}/cmdline")).ok()?;
        let command = value.replace('\0', " ").trim().to_string();
        if !command.is_empty() {
            return Some(command);
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn process_command(pid: u32) -> Option<String> {
    windows_process_name(pid)
}

#[cfg(target_os = "windows")]
fn windows_process_name(pid: u32) -> Option<String> {
    let filter = format!("PID eq {pid}");
    let output = Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .and_then(|line| line.split(',').next())
        .map(|value| value.trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

fn open_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_command("open", &[target])
    }

    #[cfg(target_os = "linux")]
    {
        run_command("xdg-open", &[target])
    }

    #[cfg(target_os = "windows")]
    {
        run_command("cmd", &["/C", "start", "", target])
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to run {program}: {err}"))
}

#[cfg(target_os = "linux")]
fn run_first_available(commands: &[(&str, &[&str])]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (program, args) in commands {
        match run_command(program, args) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(err),
        }
    }
    Err(errors.join("; "))
}

#[cfg(target_os = "linux")]
fn parse_between(value: &str, start: &str, end: &str) -> Option<String> {
    let (_, rest) = value.split_once(start)?;
    let (target, _) = rest.split_once(end)?;
    Some(target.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_ports,
            scan_capabilities,
            open_url,
            open_folder,
            open_terminal,
            kill_process
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ports_from_common_listener_addresses() {
        assert_eq!(parse_port("*:3000"), Some(3000));
        assert_eq!(parse_port("127.0.0.1:49319"), Some(49319));
        assert_eq!(parse_port("[::1]:5174"), Some(5174));
    }

    #[test]
    fn detects_html_responses() {
        let probe = HttpProbe {
            status: 200,
            content_type: Some("text/html; charset=utf-8".into()),
            location: None,
            final_path: "/".into(),
            body: String::new(),
        };

        assert!(looks_like_html(&probe));
    }

    #[test]
    fn detects_openapi_responses() {
        let probe = HttpProbe {
            status: 200,
            content_type: Some("application/json".into()),
            location: None,
            final_path: "/openapi.json".into(),
            body: r#"{"openapi":"3.1.0"}"#.into(),
        };

        assert!(looks_like_openapi(&probe));
    }

    #[test]
    fn parses_docker_published_ports() {
        let ports = "0.0.0.0:3000->3000/tcp, [::]:6379->6379/tcp, 0.0.0.0:4317-4318->4317-4318/tcp";

        assert_eq!(parse_docker_host_ports(ports), vec![3000, 6379, 4317, 4318]);
    }

    #[test]
    fn derives_probe_hosts_from_listener_address() {
        assert_eq!(probe_hosts(Some("[::1]:5173")), vec!["::1".to_string()]);
        assert_eq!(
            probe_hosts(Some("127.0.0.1:5173")),
            vec!["127.0.0.1".to_string()]
        );
        assert_eq!(
            probe_hosts(Some("*:8080")),
            vec!["127.0.0.1".to_string(), "::1".to_string()]
        );
    }

    #[test]
    fn parses_redirect_location_header() {
        let probe = parse_http_response("HTTP/1.1 302 Found\r\nLocation: /clm/\r\n\r\n")
            .expect("redirect response should parse");

        assert_eq!(probe.status, 302);
        assert_eq!(probe.location, Some("/clm/".to_string()));
        assert_eq!(
            redirect_path("http://127.0.0.1:6201/clm/"),
            Some("/clm/".into())
        );
    }

    #[test]
    fn extracts_application_bundle_name() {
        let command = "/Applications/TablePlus.app/Contents/MacOS/TablePlus --flag";

        assert_eq!(
            app_bundle_name(None, Some(command)),
            Some("TablePlus".to_string())
        );
    }

    #[test]
    fn groups_docker_by_compose_project_then_network() {
        let compose_container = DockerContainer {
            labels: "com.docker.compose.project=maf-harness,com.docker.compose.service=web".into(),
            names: "maf-web".into(),
            networks: "maf-harness_default".into(),
            ports: "0.0.0.0:3000->3000/tcp".into(),
        };
        let network_container = DockerContainer {
            labels: String::new(),
            names: "redis".into(),
            networks: "local_default,bridge".into(),
            ports: "0.0.0.0:6379->6379/tcp".into(),
        };

        assert_eq!(
            docker_group_name(&compose_container),
            "Compose: maf-harness"
        );
        assert_eq!(
            docker_group_name(&network_container),
            "Network: local_default"
        );
    }
}
