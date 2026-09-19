use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Parse newline-delimited JSON (docker's `--format json` per-line output)
/// into a Vec of values, skipping blank lines.
pub fn parse_json_lines(text: &str) -> Vec<Value> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Wire shape uses the daemon's capitalized keys (`Name`, `CPUPerc`, …),
/// so each field is renamed explicitly rather than via rename_all.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StatsSample {
    #[serde(default, rename = "Container")]
    pub container: String,
    #[serde(default, rename = "Name")]
    pub name: String,
    #[serde(default, rename = "CPUPerc")]
    pub cpu_perc: String,
    #[serde(default, rename = "MemUsage")]
    pub mem_usage: String,
    #[serde(default, rename = "MemPerc")]
    pub mem_perc: String,
    #[serde(default, rename = "NetIO")]
    pub net_io: String,
    #[serde(default, rename = "BlockIO")]
    pub block_io: String,
    #[serde(default, rename = "PIDs")]
    pub pids: String,
}

/// Parse `docker stats --no-stream --format json` output (one JSON object
/// per container; some daemons emit a JSON array instead).
pub fn parse_stats_json(text: &str) -> Vec<StatsSample> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('[') {
        return serde_json::from_str(trimmed).unwrap_or_default();
    }
    parse_json_lines(text)
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    #[serde(default)]
    pub images_size: String,
    #[serde(default)]
    pub images_reclaimable: String,
    #[serde(default)]
    pub containers_size: String,
    #[serde(default)]
    pub containers_reclaimable: String,
    #[serde(default)]
    pub volumes_size: String,
    #[serde(default)]
    pub volumes_reclaimable: String,
    #[serde(default)]
    pub build_cache_size: String,
    #[serde(default)]
    pub build_cache_reclaimable: String,
}

/// Parse `docker system df --format json` output. The daemon emits either
/// one JSON object per line (newer) or a single object with typed sections.
pub fn parse_system_df(text: &str) -> DiskUsage {
    let mut out = DiskUsage::default();
    for v in parse_json_lines(text) {
        let kind = v.get("Type").and_then(Value::as_str).unwrap_or("");
        let size = v.get("Size").and_then(Value::as_str).unwrap_or("").to_string();
        let reclaim = v
            .get("Reclaimable")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match kind {
            "Images" => {
                out.images_size = size;
                out.images_reclaimable = reclaim;
            }
            "Containers" => {
                out.containers_size = size;
                out.containers_reclaimable = reclaim;
            }
            "Local Volumes" | "Volumes" => {
                out.volumes_size = size;
                out.volumes_reclaimable = reclaim;
            }
            "Build Cache" => {
                out.build_cache_size = size;
                out.build_cache_reclaimable = reclaim;
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_lines_skips_blanks_and_garbage() {
        let text = "{\"a\":1}\n\nnot json\n{\"b\":2}\n";
        let out = parse_json_lines(text);
        assert_eq!(out, vec![json!({"a":1}), json!({"b":2})]);
    }

    #[test]
    fn stats_parses_line_and_array_shapes() {
        let line = "{\"Container\":\"abc\",\"Name\":\"web\",\"CPUPerc\":\"1.2%\",\"MemUsage\":\"10MiB / 1GiB\",\"MemPerc\":\"1%\",\"NetIO\":\"1kB / 2kB\",\"BlockIO\":\"0B / 0B\",\"PIDs\":\"3\"}";
        let out = parse_stats_json(line);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "web");
        assert_eq!(out[0].cpu_perc, "1.2%");
        let arr = format!("[{line}]");
        assert_eq!(parse_stats_json(&arr).len(), 1);
        assert!(parse_stats_json("").is_empty());
    }

    #[test]
    fn system_df_maps_typed_sections() {
        let text = "{\"Type\":\"Images\",\"Size\":\"2.1GB\",\"Reclaimable\":\"1GB (48%)\"}\n{\"Type\":\"Containers\",\"Size\":\"10MB\",\"Reclaimable\":\"0B\"}\n{\"Type\":\"Local Volumes\",\"Size\":\"500MB\",\"Reclaimable\":\"500MB (100%)\"}\n{\"Type\":\"Build Cache\",\"Size\":\"300MB\",\"Reclaimable\":\"300MB\"}\n";
        let df = parse_system_df(text);
        assert_eq!(df.images_size, "2.1GB");
        assert_eq!(df.images_reclaimable, "1GB (48%)");
        assert_eq!(df.volumes_size, "500MB");
        assert_eq!(df.build_cache_reclaimable, "300MB");
    }
}
