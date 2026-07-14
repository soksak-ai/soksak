//! Shared lexical filesystem boundary.
//!
//! Paths are never made safe by canonicalizing through a link. Every existing component is
//! inspected with `symlink_metadata`; links (and Windows reparse points) are rejected in place.

use std::path::{Component, Path, PathBuf};

#[cfg(windows)]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// Reject `..` and every existing symlink/junction component without resolving through it.
pub(crate) fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(format!(
                    "경로에 '..'를 사용할 수 없습니다: {}",
                    path.display()
                ))
            }
            Component::Normal(part) => current.push(part),
        }
        if current.as_os_str().is_empty() {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if is_link_like(&metadata) {
            return Err(format!(
                "경로에 symlink/junction을 사용할 수 없습니다: {}",
                current.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn physical_temp(name: &str) -> PathBuf {
        let temp = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        temp.join(format!(
            "soksak-path-security-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn parent_segments_are_rejected_lexically() {
        let root = physical_temp("parent");
        let path = root.join("safe").join("..").join("escape");
        assert!(reject_symlink_components(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn existing_and_dangling_symlinks_are_both_rejected() {
        use std::os::unix::fs::symlink;

        let root = physical_temp("links");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("existing-link")).unwrap();
        symlink(root.join("missing"), root.join("dangling-link")).unwrap();

        assert!(reject_symlink_components(&root.join("existing-link").join("child")).is_err());
        assert!(reject_symlink_components(&root.join("dangling-link").join("child")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
