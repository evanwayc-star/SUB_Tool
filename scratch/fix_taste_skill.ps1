$items = Get-ChildItem -Path C:\Users\Evan\.gemini\config\skills\taste-skill\skills -Directory
foreach ($item in $items) {
    Copy-Item -Path $item.FullName -Destination C:\Users\Evan\.gemini\config\skills\ -Recurse -Force
}
Remove-Item -Path C:\Users\Evan\.gemini\config\skills\taste-skill -Recurse -Force
