# 註冊 3 個 Windows 排程工作：08:00 / 17:00 / 22:30 自動跑 Gmail 機器人。
# 用法（在本資料夾，系統管理員 PowerShell）：  .\register_tasks.ps1
# 移除：  .\register_tasks.ps1 -Remove

param([switch]$Remove)

$ProjectDir = $PSScriptRoot
$VenvPy = Join-Path $ProjectDir "venv\Scripts\python.exe"
$Py = if (Test-Path $VenvPy) { $VenvPy } else { (Get-Command python).Source }
$Script = Join-Path $ProjectDir "main.py"

$tasks = @(
    @{ Name = "GmailBot_Morning";   Time = "08:00"; Arg = "morning" },
    @{ Name = "GmailBot_Afternoon"; Time = "17:00"; Arg = "afternoon" },
    @{ Name = "GmailBot_Night";     Time = "22:30"; Arg = "night" }
)

foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
        Write-Host "已移除舊工作：$($t.Name)"
    }
    if ($Remove) { continue }

    $action  = New-ScheduledTaskAction -Execute $Py -Argument "`"$Script`" $($t.Arg)" -WorkingDirectory $ProjectDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $t.Time
    # 開機後若錯過排程時間，補跑一次；電池供電也執行
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger `
        -Settings $settings -Description "Gmail 自動分類/草稿/報告（$($t.Arg)）" `
        -RunLevel Limited | Out-Null
    Write-Host "✅ 已註冊：$($t.Name) 每天 $($t.Time) → main.py $($t.Arg)"
}

# 每週五 22:30 額外的「本週總摘要」
$weeklyName = "GmailBot_Weekly"
if (Get-ScheduledTask -TaskName $weeklyName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $weeklyName -Confirm:$false
    Write-Host "已移除舊工作：$weeklyName"
}
if (-not $Remove) {
    $waction   = New-ScheduledTaskAction -Execute $Py -Argument "`"$Script`" weekly" -WorkingDirectory $ProjectDir
    $wtrigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "22:30"
    $wsettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $weeklyName -Action $waction -Trigger $wtrigger `
        -Settings $wsettings -Description "Gmail 每週五本週總摘要" -RunLevel Limited | Out-Null
    Write-Host "✅ 已註冊：$weeklyName 每週五 22:30 → main.py weekly"
}

if (-not $Remove) {
    Write-Host "`n用 Python：$Py"
    Write-Host "可在「工作排程器」看到 GmailBot_* 工作（3 個每日 + 1 個每週五）。手動測試：python main.py test"
}
