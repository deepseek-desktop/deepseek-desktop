param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseRoot,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Assert-Pe {
  param([Parameter(Mandatory = $true)][string]$Path, [int[]]$AllowedMachines = @(0x8664))

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) {
      throw "not a PE executable: $Path"
    }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "invalid PE signature: $Path"
    }
    $machine = $reader.ReadUInt16()
    if ($machine -notin $AllowedMachines) {
      throw ("unexpected PE machine 0x{0:X4}: {1}" -f $machine, $Path)
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-InstalledEntry {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $roots) {
    $entry = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq "DeepSeek Desktop" } |
      Select-Object -First 1
    if ($null -ne $entry) {
      return $entry
    }
  }
  return $null
}

function Get-UiElements {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  return $root.FindAll($scope, [System.Windows.Automation.Condition]::TrueCondition)
}

function Find-UiElement {
  param(
    [Parameter(Mandatory = $true)][string[]]$Names,
    [int[]]$ProcessIds = @()
  )

  foreach ($element in Get-UiElements) {
    try {
      $elementProcessId = $element.Current.ProcessId
      if ($ProcessIds.Count -gt 0 -and $ProcessIds -notcontains $elementProcessId) {
        continue
      }
      $name = $element.Current.Name
      if ($Names -contains $name) {
        return $element
      }
    } catch {
      continue
    }
  }
  return $null
}

function Wait-UiElement {
  param(
    [Parameter(Mandatory = $true)][string[]]$Names,
    [int[]]$ProcessIds = @(),
    [int]$TimeoutSeconds = 90
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $element = Find-UiElement -Names $Names -ProcessIds $ProcessIds
    if ($null -ne $element) {
      return $element
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "UI element did not appear: $($Names -join ', ')"
}

function Invoke-UiElement {
  param([Parameter(Mandatory = $true)]$Element)

  $pattern = $null
  if ($Element.TryGetCurrentPattern(
      [System.Windows.Automation.InvokePattern]::Pattern,
      [ref]$pattern
    )) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    return
  }
  throw "UI element does not support InvokePattern: $($Element.Current.Name)"
}

function Open-UiMenu {
  param([Parameter(Mandatory = $true)]$Element)

  # WebView2 exposes aria-haspopup menus through ExpandCollapse, not Invoke.
  $pattern = $null
  if ($Element.TryGetCurrentPattern(
      [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
      [ref]$pattern
    )) {
    ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand()
    return
  }
  Invoke-UiElement -Element $Element
}

function Activate-App {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  $shell = New-Object -ComObject WScript.Shell
  if (-not $shell.AppActivate($Process.Id)) {
    throw "could not activate DeepSeek Desktop"
  }
  Start-Sleep -Milliseconds 300
}

function Get-DescendantProcessIds {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $all = @(Get-CimInstance Win32_Process)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $result = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
      $childId = [int]$child.ProcessId
      if (-not $result.Contains($childId)) {
        $result.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }
  return $result.ToArray()
}

function Wait-AppUiElement {
  param(
    [Parameter(Mandatory = $true)][string[]]$Names,
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [int]$TimeoutSeconds = 90
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $processIds = @($RootProcessId) + @(Get-DescendantProcessIds -RootProcessId $RootProcessId)
    $element = Find-UiElement -Names $Names -ProcessIds $processIds
    if ($null -ne $element) {
      return $element
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "application UI element did not appear: $($Names -join ', ')"
}

$processorArchitectures = @(
  Get-CimInstance Win32_Processor |
    Select-Object -ExpandProperty Architecture -Unique
)
if (
  -not [Environment]::Is64BitOperatingSystem -or
  -not [Environment]::Is64BitProcess -or
  $processorArchitectures.Count -ne 1 -or
  $processorArchitectures[0] -ne 9
) {
  throw "Windows installation acceptance requires a native x64 runner"
}

$releaseDirectory = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$installers = @(Get-ChildItem -LiteralPath $releaseDirectory -Recurse -File -Filter "*_x64-setup.exe")
if ($installers.Count -ne 1) {
  throw "expected exactly one Windows x64 installer, found $($installers.Count)"
}
$installer = $installers[0]
# NSIS uses an x86 stub even when its application payload is x64.
Assert-Pe -Path $installer.FullName -AllowedMachines @(0x014c, 0x8664)

$appProcess = $null
$installedEntry = $null
$installedExecutable = $null
$childProcessIds = @()
try {
  $install = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -PassThru -Wait
  if ($install.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($install.ExitCode)"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $installedEntry = Get-InstalledEntry
    if ($null -ne $installedEntry) {
      $installLocation = [System.IO.Path]::GetFullPath($installedEntry.InstallLocation.Trim().Trim('"'))
      $candidate = Join-Path $installLocation "deepseek-desktop.exe"
      if (Test-Path -LiteralPath $candidate) {
        $installedExecutable = $candidate
        break
      }
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $installedExecutable) {
    throw "installed DeepSeek Desktop executable was not found"
  }

  Assert-Pe -Path $installedExecutable -AllowedMachines @(0x8664)
  $appProcess = Start-Process -FilePath $installedExecutable -PassThru
  $expectedTitle = "DeepSeek Desktop v$ExpectedVersion"
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "DeepSeek Desktop exited before its main window was ready"
    }
    if ($appProcess.MainWindowHandle -ne 0 -and $appProcess.MainWindowTitle -eq $expectedTitle) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($appProcess.MainWindowHandle -eq 0 -or $appProcess.MainWindowTitle -ne $expectedTitle) {
    throw "main window did not become ready with title '$expectedTitle'"
  }

  Wait-AppUiElement -Names @("新建会话", "新会话", "新增對話", "New session") -RootProcessId $appProcess.Id -TimeoutSeconds 120 | Out-Null
  $fileMenu = Wait-AppUiElement -Names @("文件", "檔案", "File") -RootProcessId $appProcess.Id
  Open-UiMenu -Element $fileMenu
  $settingsMenu = Wait-AppUiElement -Names @(
    "设置…", "设置...",
    "設定…", "設定...",
    "Settings…", "Settings..."
  ) -RootProcessId $appProcess.Id -TimeoutSeconds 15
  Invoke-UiElement -Element $settingsMenu
  Wait-AppUiElement -Names @("设置", "設定", "Settings") -RootProcessId $appProcess.Id -TimeoutSeconds 30 | Out-Null

  $childProcessIds = @(Get-DescendantProcessIds -RootProcessId $appProcess.Id)
  $nodeChildren = @($childProcessIds | Where-Object {
    (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -like "node*"
  })
  if ($nodeChildren.Count -lt 1) {
    throw "Harness Node child process was not running after the workbench became ready"
  }

  Activate-App -Process $appProcess
  [System.Windows.Forms.SendKeys]::SendWait("%{F4}")
  $cancel = Wait-AppUiElement -Names @("取消", "Cancel") -RootProcessId $appProcess.Id -TimeoutSeconds 15
  Invoke-UiElement -Element $cancel
  Start-Sleep -Milliseconds 750
  $appProcess.Refresh()
  if ($appProcess.HasExited) {
    throw "canceling the close confirmation unexpectedly exited the application"
  }

  Activate-App -Process $appProcess
  [System.Windows.Forms.SendKeys]::SendWait("%{F4}")
  $confirm = Wait-AppUiElement -Names @("关闭", "關閉", "Close") -RootProcessId $appProcess.Id -TimeoutSeconds 15
  Invoke-UiElement -Element $confirm
  if (-not $appProcess.WaitForExit(30000)) {
    throw "DeepSeek Desktop did not exit after close confirmation"
  }
  if ($appProcess.ExitCode -ne 0) {
    throw "DeepSeek Desktop exited with code $($appProcess.ExitCode)"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $remainingChildren = @($childProcessIds | Where-Object {
      $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue)
    })
    if ($remainingChildren.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remainingChildren.Count -gt 0) {
    throw "orphan child processes remained after exit: $($remainingChildren -join ', ')"
  }

  Write-Output "Windows x64 installation acceptance passed for DeepSeek Desktop $ExpectedVersion."
} finally {
  if ($null -ne $appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -eq $installedEntry) {
    $installedEntry = Get-InstalledEntry
  }
  if ($null -ne $installedEntry -and $installedEntry.UninstallString) {
    $uninstallCommand = [string]$installedEntry.UninstallString
    $quoted = [regex]::Match($uninstallCommand, '^\s*"([^"]+)"(.*)$')
    if ($quoted.Success) {
      $uninstaller = $quoted.Groups[1].Value
      $uninstallArguments = $quoted.Groups[2].Value.Trim()
    } else {
      $uninstaller = $uninstallCommand.Trim()
      $uninstallArguments = ""
    }
    if (Test-Path -LiteralPath $uninstaller) {
      $arguments = "$uninstallArguments /S".Trim()
      $uninstall = Start-Process -FilePath $uninstaller -ArgumentList $arguments -PassThru -Wait
      if ($uninstall.ExitCode -ne 0) {
        throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
      }
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ($null -ne (Get-InstalledEntry) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if ($null -ne (Get-InstalledEntry)) {
    throw "DeepSeek Desktop remained installed after acceptance cleanup"
  }
}
