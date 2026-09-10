# Reference recipe: Windows PowerShell 5.1 / PowerShell 7 on Windows.
# Run in a 64-bit elevated session, outside the Google Cloud SDK directory.
# Read README.md before running: Windows end-to-end validation is pending.
# The target is deliberately fixed at 584.0.0; this is not a latest-version updater.

& {
    $ErrorActionPreference = 'Stop'
    $old = $env:CLOUDSDK_PYTHON

    try {
        # A separate interpreter avoids updating the Python that runs the updater.
        $py = gcloud components copy-bundled-python
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not copy the bundled Python. Registry was not changed by this script.'
        }

        $env:CLOUDSDK_PYTHON = ([string]$py).Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $env:CLOUDSDK_PYTHON -PathType Leaf)) {
            throw "Copied Python was not found: $env:CLOUDSDK_PYTHON"
        }

        # On Windows, -Wait also waits for the process tree before version checks.
        $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c gcloud components update --version=584.0.0 --quiet' -NoNewWindow -Wait -PassThru
        if ($p.ExitCode -ne 0) {
            throw "gcloud update failed with exit code $($p.ExitCode). Registry was not changed by this script."
        }
    }
    finally {
        # Restore only the current process environment, including an unset value.
        $env:CLOUDSDK_PYTHON = $old
    }

    $json = gcloud version --format=json
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read the SDK version. Registry was not changed by this script.'
    }

    $v = ($json | ConvertFrom-Json).'Google Cloud SDK'
    if ($v -ne '584.0.0') {
        throw "Actual SDK version is '$v', not 584.0.0. Registry was not changed by this script."
    }

    # Do not invent an uninstall key or select the first of several installations.
    $keys = @(
        foreach ($root in 'HKCU:\Software', 'HKCU:\Software\WOW6432Node', 'HKLM:\Software', 'HKLM:\Software\WOW6432Node') {
            Get-ItemProperty -Path "$root\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
                Where-Object DisplayName -eq 'Google Cloud SDK'
        }
    )

    if ($keys.Count -ne 1) {
        throw "Found $($keys.Count) SDK uninstall entries; expected exactly one. Registry was not changed by this script."
    }

    # DisplayVersion is metadata, not an installation operation or a WinGet pin.
    New-ItemProperty -LiteralPath $keys[0].PSPath -Name DisplayVersion -PropertyType String -Value $v -Force | Out-Null

    # Display the result for inspection; this is not an automated success assertion.
    winget list --id Google.CloudSDK --exact --accept-source-agreements --disable-interactivity
}
