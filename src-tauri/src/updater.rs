use std::io::Read;
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use quick_xml::Reader;
use quick_xml::events::Event;
use quick_xml::name::QName;
use reqwest::redirect::Policy;
use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::contracts::{DesktopSettings, ReleaseNotesFormat, UpdateStatus};
use crate::error::{DesktopError, DesktopResult};

const CHECK_INTERVAL: TimeDelta = TimeDelta::hours(24);
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct GithubRepository {
    owner: String,
    name: String,
    web_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(skip)]
    notes_format: ReleaseNotesFormat,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
}

#[derive(Default)]
struct FeedEntry {
    tag: Option<String>,
    updated: Option<String>,
    content: Option<String>,
}

#[derive(Debug)]
struct ReleaseCandidate {
    version: Version,
    tag: String,
    prerelease: bool,
    published_at: DateTime<Utc>,
    notes: Option<String>,
    notes_format: ReleaseNotesFormat,
}

pub async fn check(app: &AppHandle, settings: &DesktopSettings) -> DesktopResult<UpdateStatus> {
    if settings.update_enabled && settings.update_channel == "stable" {
        return check_signed_update(app, settings).await;
    }

    let repository = official_github_repository()?;
    let releases = tauri::async_runtime::spawn_blocking(move || fetch_releases(&repository))
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))??;
    Ok(select_release(
        releases,
        settings,
        env!("DEEPSEEK_DESKTOP_APP_VERSION"),
    ))
}

pub fn check_due(last_check_at: Option<&str>, now: DateTime<Utc>) -> bool {
    let Some(last_check_at) = last_check_at else {
        return true;
    };
    DateTime::parse_from_rfc3339(last_check_at)
        .map(|last| now.signed_duration_since(last.with_timezone(&Utc)) >= CHECK_INTERVAL)
        .unwrap_or(true)
}

pub fn skipped_status(settings: &DesktopSettings) -> UpdateStatus {
    empty_status(settings, "check-skipped")
}

pub fn official_release_page(tag: &str) -> DesktopResult<String> {
    let version = parse_tag(tag).ok_or_else(|| {
        DesktopError::InvalidConfiguration("Desktop release tag must be valid SemVer".to_owned())
    })?;
    let repository = official_github_repository()?;
    let canonical_tag = if tag.starts_with('v') {
        format!("v{version}")
    } else {
        version.to_string()
    };
    Ok(format!(
        "{}/releases/tag/{canonical_tag}",
        repository.web_url
    ))
}

pub fn release_note_url(value: &str) -> DesktopResult<String> {
    let invalid = || {
        DesktopError::InvalidConfiguration(
            "release note links must be credential-free HTTP(S) URLs".to_owned(),
        )
    };
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    Ok(url.into())
}

async fn check_signed_update(
    app: &AppHandle,
    settings: &DesktopSettings,
) -> DesktopResult<UpdateStatus> {
    let endpoint =
        option_env!("DEEPSEEK_DESKTOP_UPDATER_ENDPOINT").filter(|value| !value.is_empty());
    let public_key =
        option_env!("DEEPSEEK_DESKTOP_UPDATER_PUBKEY").filter(|value| !value.is_empty());
    let (Some(endpoint), Some(public_key)) = (endpoint, public_key) else {
        return Ok(empty_status(settings, "signed-updater-not-configured"));
    };
    let endpoint = Url::parse(endpoint).map_err(|error| DesktopError::Other(error.to_string()))?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| DesktopError::Other(error.to_string()))?
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    Ok(UpdateStatus {
        enabled: true,
        channel: settings.update_channel.clone(),
        current_version: env!("DEEPSEEK_DESKTOP_APP_VERSION").to_owned(),
        available_version: update.as_ref().map(|release| release.version.clone()),
        release_tag: None,
        published_at: None,
        release_notes: None,
        release_notes_format: ReleaseNotesFormat::Markdown,
        prerelease: false,
        message: if update.is_some() {
            "update-available"
        } else {
            "up-to-date"
        }
        .to_owned(),
    })
}

fn official_github_repository() -> DesktopResult<GithubRepository> {
    parse_github_repository(env!("DEEPSEEK_DESKTOP_APP_REPOSITORY"))
}

fn parse_github_repository(value: &str) -> DesktopResult<GithubRepository> {
    let url = Url::parse(value).map_err(|_| {
        DesktopError::InvalidConfiguration("official Desktop repository is invalid".to_owned())
    })?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DesktopError::InvalidConfiguration(
            "official Desktop repository must be a credential-free GitHub HTTPS URL".to_owned(),
        ));
    }
    let segments = url
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if segments.len() != 2 {
        return Err(DesktopError::InvalidConfiguration(
            "official Desktop repository must identify one GitHub repository".to_owned(),
        ));
    }
    let owner = segments[0];
    let name = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if owner.is_empty()
        || name.is_empty()
        || !owner.chars().all(github_name_character)
        || !name.chars().all(github_name_character)
    {
        return Err(DesktopError::InvalidConfiguration(
            "official Desktop repository owner or name is invalid".to_owned(),
        ));
    }
    Ok(GithubRepository {
        owner: owner.to_owned(),
        name: name.to_owned(),
        web_url: format!("https://github.com/{owner}/{name}"),
    })
}

fn github_name_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
}

fn fetch_releases(repository: &GithubRepository) -> DesktopResult<Vec<GithubRelease>> {
    fetch_api_releases(repository).or_else(|_| fetch_release_feed(repository))
}

fn fetch_api_releases(repository: &GithubRepository) -> DesktopResult<Vec<GithubRelease>> {
    let api_url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=50",
        repository.owner, repository.name
    );
    let bytes = fetch_trusted_bytes(&api_url, "application/vnd.github+json")?;
    serde_json::from_slice(&bytes).map_err(DesktopError::Json)
}

fn fetch_release_feed(repository: &GithubRepository) -> DesktopResult<Vec<GithubRelease>> {
    let feed_url = format!("{}/releases.atom", repository.web_url);
    let bytes = fetch_trusted_bytes(&feed_url, "application/atom+xml")?;
    parse_release_feed(&bytes, repository)
}

fn fetch_trusted_bytes(url: &str, accept: &str) -> DesktopResult<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!(
            "DeepSeek-Desktop/",
            env!("DEEPSEEK_DESKTOP_APP_VERSION")
        ))
        .build()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    let response = client
        .get(url)
        .header("Accept", accept)
        .send()
        .map_err(|error| DesktopError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DesktopError::Other(format!(
            "Desktop update service returned HTTP {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(DesktopError::Other(
            "Desktop update response is too large".to_owned(),
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(DesktopError::Io)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(DesktopError::Other(
            "Desktop update response is too large".to_owned(),
        ));
    }
    Ok(bytes)
}

fn parse_release_feed(
    bytes: &[u8],
    repository: &GithubRepository,
) -> DesktopResult<Vec<GithubRelease>> {
    let xml = std::str::from_utf8(bytes)
        .map_err(|_| DesktopError::Other("Desktop update feed is not UTF-8".to_owned()))?;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut releases = Vec::new();
    let mut entry = None::<FeedEntry>;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if event.name() == QName(b"entry") => {
                entry = Some(FeedEntry::default());
            }
            Ok(Event::Empty(event)) if event.name() == QName(b"link") => {
                if let Some(entry) = entry.as_mut()
                    && attribute(&reader, &event, b"rel").as_deref() == Some("alternate")
                    && let Some(href) = attribute(&reader, &event, b"href")
                {
                    entry.tag = release_tag_from_url(repository, &href);
                }
            }
            Ok(Event::Start(event)) if entry.is_some() && event.name() == QName(b"updated") => {
                if let Some(entry) = entry.as_mut() {
                    entry.updated = Some(read_element_text(&mut reader, b"updated")?);
                }
            }
            Ok(Event::Start(event)) if entry.is_some() && event.name() == QName(b"content") => {
                if let Some(entry) = entry.as_mut() {
                    entry.content = Some(read_element_text(&mut reader, b"content")?);
                }
            }
            Ok(Event::End(event)) if event.name() == QName(b"entry") => {
                if let Some(entry) = entry.take()
                    && let Some(release) = feed_entry_to_release(entry, repository)
                {
                    releases.push(release);
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(DesktopError::Other(format!(
                    "Desktop update feed is invalid: {error}"
                )));
            }
        }
    }
    Ok(releases)
}

fn attribute(
    reader: &Reader<&[u8]>,
    event: &quick_xml::events::BytesStart<'_>,
    name: &[u8],
) -> Option<String> {
    event
        .attributes()
        .with_checks(true)
        .filter_map(Result::ok)
        .find(|attribute| attribute.key == QName(name))?
        .decoded_and_normalized_value(quick_xml::XmlVersion::Explicit1_0, reader.decoder())
        .ok()
        .map(|value| value.into_owned())
}

fn read_element_text(reader: &mut Reader<&[u8]>, name: &[u8]) -> DesktopResult<String> {
    let text = reader
        .read_text(QName(name))
        .map_err(|error| DesktopError::Other(format!("Desktop update feed is invalid: {error}")))?;
    let decoded = text
        .decode()
        .map_err(|error| DesktopError::Other(format!("Desktop update feed is invalid: {error}")))?;
    quick_xml::escape::unescape(&decoded)
        .map(|text| text.into_owned())
        .map_err(|error| DesktopError::Other(format!("Desktop update feed is invalid: {error}")))
}

fn release_tag_from_url(repository: &GithubRepository, value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let expected_prefix = format!("/{}/{}/releases/tag/", repository.owner, repository.name);
    let tag = url.path().strip_prefix(&expected_prefix)?;
    if tag.is_empty() || tag.contains('/') || parse_tag(tag).is_none() {
        return None;
    }
    Some(tag.to_owned())
}

fn feed_entry_to_release(entry: FeedEntry, repository: &GithubRepository) -> Option<GithubRelease> {
    let tag_name = entry.tag?;
    let version = parse_tag(&tag_name)?;
    let content = entry.content.unwrap_or_default();
    Some(GithubRelease {
        tag_name: tag_name.clone(),
        draft: false,
        prerelease: !version.pre.is_empty(),
        published_at: entry.updated,
        body: sanitize_notes(Some(content.clone())),
        notes_format: ReleaseNotesFormat::Html,
        assets: release_assets_from_html(repository, &tag_name, &content),
    })
}

fn release_assets_from_html(
    repository: &GithubRepository,
    tag: &str,
    content: &str,
) -> Vec<GithubAsset> {
    let expected_prefix = format!(
        "https://github.com/{}/{}/releases/download/{tag}/",
        repository.owner, repository.name
    );
    let mut assets = Vec::new();
    for marker in ["href=\"", "href='"] {
        let quote = marker.as_bytes()[5] as char;
        let mut remainder = content;
        while let Some(start) = remainder.find(marker) {
            remainder = &remainder[start + marker.len()..];
            let Some(end) = remainder.find(quote) else {
                break;
            };
            let value = &remainder[..end];
            remainder = &remainder[end + 1..];
            if let Some(name) = value.strip_prefix(&expected_prefix)
                && !name.is_empty()
                && !name.contains(['/', '?', '#'])
            {
                assets.push(GithubAsset {
                    name: name.to_owned(),
                });
            }
        }
    }
    assets
}

fn select_release(
    releases: Vec<GithubRelease>,
    settings: &DesktopSettings,
    current_version: &str,
) -> UpdateStatus {
    let Ok(current) = Version::parse(current_version) else {
        return empty_status(settings, "up-to-date");
    };
    let allow_prerelease = settings.update_channel == "community";
    let candidate = releases
        .into_iter()
        .filter(|release| !release.draft && (allow_prerelease || !release.prerelease))
        .filter(|release| has_complete_assets(&release.assets))
        .filter_map(to_candidate)
        .filter(|release| release.version > current)
        .max_by(|left, right| {
            left.version
                .cmp(&right.version)
                .then_with(|| left.published_at.cmp(&right.published_at))
        });
    let Some(candidate) = candidate else {
        return empty_status(settings, "up-to-date");
    };
    let version = candidate.version.to_string();
    let ignored = settings.desktop_update_ignored_version.as_deref() == Some(version.as_str());
    UpdateStatus {
        enabled: false,
        channel: settings.update_channel.clone(),
        current_version: current_version.to_owned(),
        available_version: Some(version),
        release_tag: Some(candidate.tag),
        published_at: Some(candidate.published_at.to_rfc3339()),
        release_notes: candidate.notes,
        release_notes_format: candidate.notes_format,
        prerelease: candidate.prerelease,
        message: if ignored {
            "update-ignored"
        } else {
            "update-available"
        }
        .to_owned(),
    }
}

fn to_candidate(release: GithubRelease) -> Option<ReleaseCandidate> {
    let version = parse_tag(&release.tag_name)?;
    let published_at = DateTime::parse_from_rfc3339(release.published_at.as_deref()?)
        .ok()?
        .with_timezone(&Utc);
    Some(ReleaseCandidate {
        version,
        tag: release.tag_name,
        prerelease: release.prerelease,
        published_at,
        notes: sanitize_notes(release.body),
        notes_format: release.notes_format,
    })
}

fn parse_tag(tag: &str) -> Option<Version> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    Version::parse(version).ok()
}

fn has_complete_assets(assets: &[GithubAsset]) -> bool {
    let names = assets
        .iter()
        .map(|asset| asset.name.to_ascii_lowercase())
        .collect::<Vec<_>>();
    [
        names
            .iter()
            .any(|name| name.ends_with(".dmg") && name.contains("aarch64")),
        names
            .iter()
            .any(|name| name.ends_with(".dmg") && name.contains("x64")),
        names
            .iter()
            .any(|name| name.ends_with(".exe") && name.contains("x64") && name.contains("setup")),
        names
            .iter()
            .any(|name| name.ends_with(".appimage") && name.contains("amd64")),
        names
            .iter()
            .any(|name| name.ends_with(".deb") && name.contains("amd64")),
        names.iter().any(|name| name == "sha256sums"),
    ]
    .into_iter()
    .all(|present| present)
}

fn sanitize_notes(notes: Option<String>) -> Option<String> {
    let notes = notes?
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .collect::<String>();
    let notes = notes.trim();
    (!notes.is_empty()).then(|| notes.to_owned())
}

fn empty_status(settings: &DesktopSettings, message: &str) -> UpdateStatus {
    UpdateStatus {
        enabled: settings.update_enabled && settings.update_channel == "stable",
        channel: settings.update_channel.clone(),
        current_version: env!("DEEPSEEK_DESKTOP_APP_VERSION").to_owned(),
        available_version: None,
        release_tag: None,
        published_at: None,
        release_notes: None,
        release_notes_format: ReleaseNotesFormat::Markdown,
        prerelease: false,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_note_links_only_open_web_pages() {
        for valid in [
            "https://example.com/download/app.dmg",
            "http://example.com/notes#fixes",
        ] {
            assert_eq!(release_note_url(valid).unwrap(), valid);
        }
        for invalid in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,test",
            "mailto:test@example.com",
            "https://user:password@example.com",
            "/relative",
        ] {
            assert!(release_note_url(invalid).is_err(), "{invalid}");
        }
    }

    fn release(tag: &str, prerelease: bool, published_at: &str) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_owned(),
            draft: false,
            prerelease,
            published_at: Some(published_at.to_owned()),
            body: Some("Release notes".to_owned()),
            notes_format: ReleaseNotesFormat::Markdown,
            assets: [
                "DeepSeek.Desktop_1.0.0_aarch64.dmg",
                "DeepSeek.Desktop_1.0.0_x64.dmg",
                "DeepSeek.Desktop_1.0.0_x64-setup.exe",
                "DeepSeek.Desktop_1.0.0_amd64.AppImage",
                "DeepSeek.Desktop_1.0.0_amd64.deb",
                "SHA256SUMS",
            ]
            .into_iter()
            .map(|name| GithubAsset {
                name: name.to_owned(),
            })
            .collect(),
        }
    }

    #[test]
    fn accepts_only_the_build_time_github_repository_shape() {
        let repository = parse_github_repository("https://github.com/example/desktop.git").unwrap();
        assert_eq!(repository.web_url, "https://github.com/example/desktop");
        for invalid in [
            "http://github.com/example/desktop",
            "https://token@github.com/example/desktop",
            "https://example.com/example/desktop",
            "https://github.com/example/desktop/releases",
        ] {
            assert!(parse_github_repository(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn selects_the_highest_complete_semver_release() {
        let settings = DesktopSettings::default();
        let mut incomplete = release("v9.0.0", false, "2026-08-30T10:00:00Z");
        incomplete.assets.pop();
        let status = select_release(
            vec![
                release("v1.1.0", false, "2026-08-30T10:00:00Z"),
                release("v1.2.0", false, "2026-08-30T09:00:00Z"),
                incomplete,
            ],
            &settings,
            "1.0.0",
        );
        assert_eq!(status.available_version.as_deref(), Some("1.2.0"));
        assert_eq!(status.release_tag.as_deref(), Some("v1.2.0"));
    }

    #[test]
    fn ignores_draft_releases() {
        let settings = DesktopSettings::default();
        let mut draft = release("v2.0.0", false, "2026-08-30T10:00:00Z");
        draft.draft = true;
        let status = select_release(vec![draft], &settings, "1.0.0");
        assert_eq!(status.message, "up-to-date");
        assert!(status.available_version.is_none());
    }

    #[test]
    fn community_accepts_prereleases_but_stable_does_not() {
        let releases = vec![release("v1.1.0-beta.1", true, "2026-08-30T10:00:00Z")];
        let community = select_release(releases, &DesktopSettings::default(), "1.0.0");
        assert_eq!(community.message, "update-available");

        let stable = DesktopSettings {
            update_channel: "stable".to_owned(),
            ..DesktopSettings::default()
        };
        let status = select_release(
            vec![release("v1.1.0-beta.1", true, "2026-08-30T10:00:00Z")],
            &stable,
            "1.0.0",
        );
        assert_eq!(status.message, "up-to-date");
    }

    #[test]
    fn ignored_version_stays_available_without_prompting() {
        let settings = DesktopSettings {
            desktop_update_ignored_version: Some("1.1.0".to_owned()),
            ..DesktopSettings::default()
        };
        let status = select_release(
            vec![release("v1.1.0", false, "2026-08-30T10:00:00Z")],
            &settings,
            "1.0.0",
        );
        assert_eq!(status.message, "update-ignored");
        assert_eq!(status.available_version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn silent_checks_run_at_most_once_per_day() {
        let now = Utc::now();
        assert!(!check_due(
            Some(&(now - TimeDelta::hours(23)).to_rfc3339()),
            now
        ));
        assert!(check_due(
            Some(&(now - TimeDelta::hours(24)).to_rfc3339()),
            now
        ));
        assert!(check_due(None, now));
    }

    #[test]
    fn release_pages_ignore_remote_asset_urls() {
        let page = official_release_page("v1.2.3-beta.1").unwrap();
        assert!(page.starts_with("https://github.com/"));
        assert!(page.ends_with("/releases/tag/v1.2.3-beta.1"));
        assert!(official_release_page("../latest").is_err());
    }

    #[test]
    fn parses_a_complete_trusted_atom_release() {
        let repository = parse_github_repository("https://github.com/example/desktop").unwrap();
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
          <feed xmlns="http://www.w3.org/2005/Atom">
            <entry>
              <updated>2026-09-01T12:00:00Z</updated>
              <link rel="alternate" href="https://github.com/example/desktop/releases/tag/v1.2.3"/>
              <content type="html">
                &lt;p&gt;A complete release.&lt;/p&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/DeepSeek.Desktop_1.2.3_aarch64.dmg&quot;&gt;arm&lt;/a&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/DeepSeek.Desktop_1.2.3_x64.dmg&quot;&gt;intel&lt;/a&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/DeepSeek.Desktop_1.2.3_x64-setup.exe&quot;&gt;windows&lt;/a&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/DeepSeek.Desktop_1.2.3_amd64.AppImage&quot;&gt;appimage&lt;/a&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/DeepSeek.Desktop_1.2.3_amd64.deb&quot;&gt;deb&lt;/a&gt;
                &lt;a href=&quot;https://github.com/example/desktop/releases/download/v1.2.3/SHA256SUMS&quot;&gt;hashes&lt;/a&gt;
              </content>
            </entry>
          </feed>"#;
        let releases = parse_release_feed(xml.as_bytes(), &repository).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v1.2.3");
        assert!(!releases[0].prerelease);
        assert!(has_complete_assets(&releases[0].assets));
        assert!(
            releases[0]
                .body
                .as_deref()
                .is_some_and(|notes| { notes.contains("<p>A complete release.</p>") })
        );
        let status = select_release(releases, &DesktopSettings::default(), "1.0.0");
        assert_eq!(status.release_notes_format, ReleaseNotesFormat::Html);
    }

    #[test]
    fn preserves_long_notes_and_ignores_remote_format_overrides() {
        let notes = format!(
            "# Release\n\n{}\n\n[Details](https://example.com/notes)",
            "A paragraph.\n\n".repeat(150)
        );
        let mut candidate = release("v1.1.0", false, "2026-09-04T10:00:00Z");
        candidate.body = Some(notes.clone());
        let status = select_release(vec![candidate], &DesktopSettings::default(), "1.0.0");
        assert_eq!(status.release_notes.as_deref(), Some(notes.as_str()));
        assert_eq!(status.release_notes_format, ReleaseNotesFormat::Markdown);
        let remote: GithubRelease = serde_json::from_str(r#"{"tag_name":"v1.1.0","draft":false,"prerelease":false,"published_at":null,"body":"<h1>raw</h1>","notes_format":"html"}"#).unwrap();
        assert_eq!(remote.notes_format, ReleaseNotesFormat::Markdown);
    }

    #[test]
    fn atom_assets_cannot_escape_the_official_repository() {
        let repository = parse_github_repository("https://github.com/example/desktop").unwrap();
        let content = r#"
          <a href="https://evil.example/releases/download/v1.2.3/SHA256SUMS">foreign</a>
          <a href="https://github.com/example/desktop/releases/download/v1.2.3/../SHA256SUMS">traversal</a>
          <a href="https://github.com/example/desktop/releases/download/v1.2.4/SHA256SUMS">wrong tag</a>
        "#;
        assert!(release_assets_from_html(&repository, "v1.2.3", content).is_empty());
        assert!(
            release_tag_from_url(
                &repository,
                "https://github.com/example/other/releases/tag/v1.2.3"
            )
            .is_none()
        );
    }
}
