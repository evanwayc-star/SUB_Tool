$items = Get-ChildItem -Path scratch\mattpocock-skills -Directory
foreach ($item in $items) {
    if ($item.Name -ne '.git') {
        Copy-Item -Path $item.FullName -Destination .agents\skills\ -Recurse -Force
    }
}
