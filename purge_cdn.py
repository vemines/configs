import os
import glob
import urllib.request
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

def get_matching_files(project_dir, patterns):
    """Scans project_dir and returns relative file paths matching specified inclusion and exclusion patterns.
    
    Supports:
      - Inclusion patterns: e.g. 'vemines.cc/**/*', 'images/**/*'
      - Exclusion patterns (starts with '!'): e.g. '!.*', '!.git/**/*'
    """
    exclusion_patterns = [p[1:] for p in patterns if p.startswith('!')]
    inclusion_patterns = [p for p in patterns if not p.startswith('!')]

    matched_files = set()

    # Process inclusion patterns
    for pattern in inclusion_patterns:
        glob_pattern = os.path.join(project_dir, pattern)
        for file_path in glob.glob(glob_pattern, recursive=True):
            if os.path.isfile(file_path):
                rel_path = os.path.relpath(file_path, project_dir)
                # Convert Windows backslashes to standard forward slashes for URLs
                matched_files.add(rel_path.replace("\\", "/"))

    # Process exclusion patterns
    for exclude_pattern in exclusion_patterns:
        exclude_glob_pattern = os.path.join(project_dir, exclude_pattern)
        for file_path in glob.glob(exclude_glob_pattern, recursive=True):
            if os.path.isfile(file_path):
                rel_path = os.path.relpath(file_path, project_dir).replace("\\", "/")
                matched_files.discard(rel_path)

    return sorted(list(matched_files))


def purge_single_file(repo, branch, rel_path):
    """Sends a GET request to purge.jsdelivr.net for a single relative file path."""
    purge_url = f"https://purge.jsdelivr.net/gh/{repo}@{branch}/{rel_path}"
    req = urllib.request.Request(
        purge_url, 
        headers={"User-Agent": "jsDelivr-Cache-Purger/1.0"}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode('utf-8')
            data = json.loads(res_body)
            status = data.get("status", "finished")
            return rel_path, True, f"[STATUS: {status}] {purge_url}"
    except Exception as e:
        return rel_path, False, f"[ERROR: {e}] {purge_url}"


def purge_jsdelivr_cache(repo, branch, project_dir, patterns, max_workers=5):
    """Finds all matching files in project_dir based on patterns and purges their jsDelivr CDN cache."""
    print(f"Scanning files in '{project_dir}' for repo: {repo}@{branch}...")
    files_to_purge = get_matching_files(project_dir, patterns)
    
    if not files_to_purge:
        print("Warning: No matching files found to purge!")
        return

    print(f"Found {len(files_to_purge)} files. Starting CDN purge...\n")

    success_count = 0
    fail_count = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(purge_single_file, repo, branch, path): path for path in files_to_purge}
        for future in as_completed(futures):
            rel_path, success, message = future.result()
            if success:
                print(f"  [SUCCESS] Purged: {rel_path}")
                success_count += 1
            else:
                print(f"  [FAILED]  Purged: {rel_path} -> {message}")
                fail_count += 1

    print("\n" + "=" * 60)
    print(f"Purge complete! Successfully purged {success_count}/{len(files_to_purge)} files.")
    if fail_count > 0:
        print(f"Warning: {fail_count} files failed to purge.")
    print("=" * 60)


if __name__ == "__main__":
    # Repository details
    REPO_NAME = "vemines/configs"
    BRANCH_NAME = "main"
    FOLDER_DIRECTORY = "."  # Use '.' for current directory

    # Select folder patterns (Supports inclusion and exclusion starting with '!')
    FOLDERS_PATTERN = [
        "vemines.cc/**/*",
        "!images/**/*", # Exclude pattern example
    ]

    purge_jsdelivr_cache(
        repo=REPO_NAME,
        branch=BRANCH_NAME,
        project_dir=FOLDER_DIRECTORY,
        patterns=FOLDERS_PATTERN,
        max_workers=5
    )
