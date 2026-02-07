# Set proxy for downloads
$Env:http_proxy = "http://127.0.0.1:17890"
$Env:https_proxy = "http://127.0.0.1:17890"

# Use a local CARGO_HOME to avoid global lock conflicts and permission issues
# This creates a self-contained environment for this project
$Env:CARGO_HOME = "$PSScriptRoot\.cargo_local"

# Ensure the directory exists
if (-not (Test-Path $Env:CARGO_HOME)) {
    New-Item -ItemType Directory -Force -Path $Env:CARGO_HOME | Out-Null
    Write-Host "Created local CARGO_HOME at $Env:CARGO_HOME"
}

Write-Host "Starting Server with Local Cargo Home..."
Write-Host "CARGO_HOME: $Env:CARGO_HOME"

# Run the server
cargo run
