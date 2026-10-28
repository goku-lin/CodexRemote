param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot), [string]$ConnectorHome, [switch]$ValidateOnly, [switch]$VerifyStatusOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$script:managerHome = $ConnectorHome
$script:managerRoot = $ProjectRoot
$script:managerApp = if ($ConnectorHome) { Join-Path $ProjectRoot 'app' } else { Join-Path $ProjectRoot 'src' }
$script:managerData = if ($ConnectorHome) { Join-Path $ConnectorHome 'state' } else { Join-Path $ProjectRoot '.relay-data' }
$script:managerNode = if ($ConnectorHome) { Join-Path $ProjectRoot 'runtime\node.exe' } else { (Get-Command node.exe -ErrorAction Stop).Source }

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Codex Remote · 启动与管理" Width="1020" Height="790" MinWidth="860" MinHeight="660" WindowStartupLocation="CenterScreen" Background="#17191C" Foreground="#EEEEEE" FontFamily="Microsoft YaHei UI" FontSize="13">
 <Window.Resources>
  <Style TargetType="TextBlock"><Setter Property="Foreground" Value="#E6E8EC"/><Setter Property="TextWrapping" Value="Wrap"/></Style>
  <Style TargetType="Button"><Setter Property="Margin" Value="0,0,10,10"/><Setter Property="Padding" Value="14,9"/><Setter Property="Background" Value="#30353C"/><Setter Property="Foreground" Value="#F1F4F7"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Cursor" Value="Hand"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border x:Name="Frame" Background="{TemplateBinding Background}" CornerRadius="7" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Frame" Property="Opacity" Value="0.8"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter TargetName="Frame" Property="Opacity" Value="0.4"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  <Style TargetType="TabItem"><Setter Property="Foreground" Value="#E7EDF4"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="TabItem"><Border x:Name="TabBorder" Background="#24282E" Padding="20,12" Margin="0,0,6,0" CornerRadius="7,7,0,0"><ContentPresenter ContentSource="Header"/></Border><ControlTemplate.Triggers><Trigger Property="IsSelected" Value="True"><Setter TargetName="TabBorder" Property="Background" Value="#375C51"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  <Style TargetType="GroupBox"><Setter Property="Foreground" Value="#E6E8EC"/><Setter Property="BorderBrush" Value="#383E46"/><Setter Property="Margin" Value="0,0,0,14"/><Setter Property="Padding" Value="16"/></Style>
  <Style TargetType="TextBox"><Setter Property="Background" Value="#1C2025"/><Setter Property="Foreground" Value="#DAE1EA"/><Setter Property="BorderBrush" Value="#434B56"/><Setter Property="Padding" Value="9"/></Style>
 </Window.Resources>
 <Grid Margin="24">
  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <Grid Margin="0,0,0,18"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
   <StackPanel><TextBlock Text="Codex Remote" FontSize="25" FontWeight="SemiBold"/><TextBlock Text="启动、连接与本机执行器，集中管理" Foreground="#9CA7B5" Margin="0,5,0,0"/></StackPanel>
   <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center"><TextBlock x:Name="TopStatus" Text="正在读取本机状态…" VerticalAlignment="Center" Margin="0,0,14,0"/><Button x:Name="RefreshBtn" Content="刷新状态" Margin="0"/></StackPanel>
  </Grid>
  <TabControl Grid.Row="1" Background="#20242A" BorderThickness="0" Padding="18">
   <TabItem Header="启动与服务"><ScrollViewer VerticalScrollBarVisibility="Auto"><StackPanel>
    <TextBlock Text="工作台" FontSize="20" FontWeight="SemiBold" Margin="0,0,0,14"/>
    <WrapPanel><Button x:Name="StartDesktopBtn" Content="启动 Codex + 服务" Background="#62DDB0" Foreground="#10241D"/><Button x:Name="StartServiceBtn" Content="仅启动服务"/><Button x:Name="OpenWebBtn" Content="打开对话网页 ↗"/></WrapPanel>
    <TextBlock Text="窗口关闭后服务继续运行。已打开的 Codex 会保留当前任务。" Foreground="#9CA7B5" Margin="0,0,0,17"/>
    <ItemsControl x:Name="HealthRows"><ItemsControl.ItemTemplate><DataTemplate><Border Background="#292E35" CornerRadius="8" Margin="0,0,0,7" Padding="14,11"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="130"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="{Binding Label}" Foreground="#AAB5C4"/><TextBlock Grid.Column="1" Text="{Binding Message}"/></Grid></Border></DataTemplate></ItemsControl.ItemTemplate></ItemsControl>
    <WrapPanel Margin="0,8,0,3"><Button x:Name="RecoverBtn" Content="恢复远程入口"/><Button x:Name="OpenLogsBtn" Content="打开服务日志目录"/></WrapPanel>
    <GroupBox Header="账号切换"><StackPanel><TextBlock x:Name="AccountSwitcherHint" Text="正在检查本机账号工具…" Foreground="#AAB5C4" Margin="0,0,0,10"/><Button x:Name="AccountSwitcherBtn" Content="打开账号切换" HorizontalAlignment="Left"/><TextBlock Text="切换时会重启 Codex 并中断桌面任务；Relay 保持运行，随后通过原生入口恢复远程接管。" Foreground="#9CA7B5"/></StackPanel></GroupBox>
    <GroupBox Header="版本与更新"><StackPanel><TextBlock x:Name="VersionText" Text="正在读取版本…" Margin="0,0,0,12"/><WrapPanel><Button x:Name="CheckUpdateBtn" Content="检查连接器更新"/><Button x:Name="InstallUpdateBtn" Content="安装连接器更新"/></WrapPanel><TextBlock x:Name="UpdateHint" Text="检查新版后可查看说明并选择安装；有任务运行时暂缓。" Foreground="#9CA7B5"/><TextBox x:Name="ReleaseNotes" IsReadOnly="True" TextWrapping="Wrap" MaxHeight="200" VerticalScrollBarVisibility="Auto" Visibility="Collapsed" Margin="0,10,0,0" Padding="10" Background="#181D23" Foreground="#E6E8EC" BorderBrush="#434B56"/></StackPanel></GroupBox>
   </StackPanel></ScrollViewer></TabItem>
   <TabItem Header="插件与执行器"><Grid><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <StackPanel><TextBlock Text="本机委派执行器" FontSize="20" FontWeight="SemiBold"/><TextBlock Text="Claude Code、DSH 及模型路由。这里控制后续委派调用，不会结束正在运行的子任务。" Foreground="#9CA7B5" Margin="0,8,0,16"/></StackPanel>
    <DataGrid x:Name="ExecutorsGrid" Grid.Row="1" AutoGenerateColumns="False" IsReadOnly="True" CanUserAddRows="False" SelectionMode="Single" RowHeight="33" Background="#20242A" Foreground="#DEE7EF" BorderBrush="#414852" RowBackground="#292E35" AlternatingRowBackground="#252A31" GridLinesVisibility="None" HeadersVisibility="Column" EnableRowVirtualization="True">
     <DataGrid.ColumnHeaderStyle><Style TargetType="DataGridColumnHeader"><Setter Property="Background" Value="#343C46"/><Setter Property="Foreground" Value="#DDE5EF"/><Setter Property="Padding" Value="10"/></Style></DataGrid.ColumnHeaderStyle>
     <DataGrid.Columns><DataGridTextColumn Header="执行器" Binding="{Binding name}" Width="190"/><DataGridTextColumn Header="状态" Binding="{Binding state}" Width="120"/><DataGridTextColumn Header="方式" Binding="{Binding execution}" Width="100"/><DataGridTextColumn Header="可用模型" Binding="{Binding models}" Width="*"/></DataGrid.Columns>
    </DataGrid>
    <StackPanel Grid.Row="2" Margin="0,14,0,0"><TextBlock x:Name="ExecutorPath" Foreground="#AAB5C4" Margin="0,0,0,10"/><WrapPanel><Button x:Name="EnableExecutorBtn" Content="启用所选"/><Button x:Name="DisableExecutorBtn" Content="停用所选"/><Button x:Name="OpenExecutorBtn" Content="打开程序目录"/><Button x:Name="OpenConfigBtn" Content="打开模型配置"/><Button x:Name="OpenRecordsBtn" Content="查看执行记录"/></WrapPanel><TextBlock Text="CLI 的登录和升级由各工具自身管理；这里只显示已配置状态，不把它当作已登录或正在运行。" Foreground="#9CA7B5"/></StackPanel>
   </Grid></TabItem>
   <TabItem Header="重启与恢复"><ScrollViewer VerticalScrollBarVisibility="Auto"><StackPanel>
    <TextBlock Text="恢复操作" FontSize="20" FontWeight="SemiBold" Margin="0,0,0,12"/>
    <TextBlock Text="刷新后台代码只重启远程服务。完整重启会中断这台电脑全部 Codex 任务，请只在需要时操作。" Foreground="#B3BDC9" Margin="0,0,0,20"/>
    <TextBlock Text="重启范围" Margin="0,0,0,8"/><ComboBox x:Name="RestartScope" SelectedIndex="0" Width="340" HorizontalAlignment="Left" Padding="8" Margin="0,0,0,16"><ComboBoxItem Content="仅重启远程服务 / 刷新后台代码" Tag="service"/><ComboBoxItem Content="重启 Codex + 远程服务" Tag="desktop"/></ComboBox>
    <CheckBox x:Name="ConfirmDesktop" Foreground="#F3C785" Content="我确认中断此电脑所有正在运行的 Codex 任务" Margin="0,0,0,18"/>
    <TextBlock Text="重启密码" Margin="0,0,0,8"/><PasswordBox x:Name="RestartPassword" Width="340" HorizontalAlignment="Left" Padding="10" Background="#181D23" Foreground="#EEEEEE" BorderBrush="#434B56" Margin="0,0,0,14"/>
    <WrapPanel><Button x:Name="RestartBtn" Content="提交重启请求" Background="#3C6155"/></WrapPanel>
    <TextBlock Text="设置或修改密码" Margin="0,10,0,8"/><WrapPanel><PasswordBox x:Name="NewPassword" Width="220" Padding="10" Background="#181D23" Foreground="#EEEEEE" BorderBrush="#434B56" Margin="0,0,10,10"/><PasswordBox x:Name="ConfirmNewPassword" Width="220" Padding="10" Background="#181D23" Foreground="#EEEEEE" BorderBrush="#434B56" Margin="0,0,10,10"/></WrapPanel>
    <WrapPanel><Button x:Name="PasswordSaveBtn" Content="保存重启密码" Background="#3C6155"/></WrapPanel>
    <TextBlock x:Name="MaintenanceHint" Foreground="#AAB5C4"/><TextBlock x:Name="MaintenanceJob" Foreground="#62DDB0" Margin="0,12,0,0"/>
   </StackPanel></ScrollViewer></TabItem>
  </TabControl>
  <StackPanel Grid.Row="2" Margin="0,15,0,0"><TextBlock x:Name="OperationStatus" Text="只读取状态，打开窗口不会自动重启或更新服务。" Foreground="#9BAFC0" Margin="0,0,0,7"/><TextBox x:Name="ActivityLog" IsReadOnly="True" TextWrapping="Wrap" Height="95" VerticalScrollBarVisibility="Auto" FontFamily="Consolas, Microsoft YaHei UI" FontSize="11"/></StackPanel>
 </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $xaml
$script:managerWindow = [Windows.Markup.XamlReader]::Load($reader)
function Ui([string]$name) { $script:managerWindow.FindName($name) }
if ($ValidateOnly) { Write-Output 'Manager WPF loaded'; $script:managerWindow.Close(); exit 0 }
$script:managerTask = $null
$script:managerLast = $null
$script:managerLastStatus = [DateTime]::UtcNow.AddSeconds(-20)
$script:managerClosing = $false
$script:managerVerifyStarted = [DateTime]::UtcNow
$script:managerVerificationError = $null
$script:managerControls = @('StartDesktopBtn','StartServiceBtn','CheckUpdateBtn','InstallUpdateBtn','RecoverBtn','RestartBtn','EnableExecutorBtn','DisableExecutorBtn','RefreshBtn','AccountSwitcherBtn')
function Write-ManagerLog([string]$text) {
  $box = Ui 'ActivityLog'
  $lines = @($box.Text -split "`r?`n" | Select-Object -Last 70)
  $box.Text = (($lines + ((Get-Date -Format 'HH:mm:ss') + '  ' + $text)) -join "`r`n").Trim()
  $box.ScrollToEnd()
}
function Manager-Request($request) {
  if ($script:managerTask -or $script:managerClosing) { return }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:managerNode
  $info.Arguments = '"' + (Join-Path $script:managerApp 'launcher-manager.mjs') + '" --root "' + $script:managerRoot + '"'
  if ($script:managerHome) { $info.Arguments += ' --home "' + $script:managerHome + '"' }
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  try {
    $process = [Diagnostics.Process]::Start($info)
    $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
    # Framework PowerShell inherits the local console code page and may emit a BOM.
    # ASCII-safe JSON preserves Chinese and surrogate pairs across both hosts.
    $wireJson=$request | ConvertTo-Json -Depth 6 -Compress
    $wireJson=[regex]::Replace($wireJson,'[^\x00-\x7F]',{ param($match) '\u'+([int][char]$match.Value).ToString('x4') })
    $process.StandardInput.Write($wireJson); $process.StandardInput.Close()
    $script:managerTask = @{ Process=$process; Output=$out; Error=$err; Action=$request.action; Started=[DateTime]::UtcNow }
    foreach ($name in $script:managerControls) { (Ui $name).IsEnabled = $false }
    (Ui 'OperationStatus').Text = if ($request.action -eq 'status') { '正在读取本机状态…' } else { '正在执行操作，请稍候…' }
  } catch { Write-ManagerLog $_.Exception.Message }
}
function Render-ManagerStatus($value) {
  $script:managerLast = $value
  (Ui 'TopStatus').Text = if ($value.online) { '● 本机后台已连接' } else { '○ 本机后台未响应' }
  $rows = @(); $labels = @{relay='Relay 后台';runner='Runner';desktop='Codex 桌面';tailscale='Tailscale';external='公网入口'}
  foreach ($key in @('relay','runner','desktop','tailscale','external')) {
    $message = $value.health.$key.message
    if (-not $message) { $message = '等待后台返回状态' }
    $rows += [pscustomobject]@{Label=$labels[$key];Message=$message}
  }
  (Ui 'HealthRows').ItemsSource = $rows
  (Ui 'AccountSwitcherHint').Text=if ($value.accountSwitcher.available) { if ($value.accountSwitcher.integrated) {'已兼容本机账号切换工具；桌面原有 switch.bat 入口也可继续使用。'} else {'发现桌面 Codex 账号工具，打开时自动连接原生启动入口。'} } else {'未找到桌面 Codex 文件夹中的 codex-switch.ps1；账号文件不会通过 OTA 复制。'}
  (Ui 'VersionText').Text = '管理程序：' + $value.managerVersion + "`n远程服务：" + $value.version + "`n桌面 CLI（上次核对）：" + $(if ($value.cliVersion) {$value.cliVersion} else {'下次原生启动时自动核对'})
  $selected = (Ui 'ExecutorsGrid').SelectedItem.id
  (Ui 'ExecutorsGrid').ItemsSource = @($value.executors.providers)
  if ($selected) { foreach ($row in (Ui 'ExecutorsGrid').Items) { if ($row.id -eq $selected) { (Ui 'ExecutorsGrid').SelectedItem = $row; break } } }
  (Ui 'MaintenanceHint').Text = if ($value.maintenance.passwordConfigured) { '重启密码已设置。窗口只校验密码，修改需使用本机设置工具。' } else { '尚未设置重启密码，或后台未响应。请在本机设置后刷新。' }
  $jobLabels = @{queued='已接受恢复请求';restarting_desktop='正在重启 Codex';restarting_service='正在重启远程服务';waiting='正在等待恢复';complete='恢复完成';failed='恢复失败'}
  (Ui 'MaintenanceJob').Text = if ($value.job) { $jobLabels[$value.job.state] + '  ' + $value.job.error } else { '' }
  if (-not $value.executors.configured) { (Ui 'ExecutorPath').Text = '这台电脑尚未配置委派执行器。配置路径：' + $value.executors.file }
}
function Confirm-Network([string]$message) {
  return [Windows.MessageBox]::Show($script:managerWindow,$message + "`n远程网页可能短暂断线。是否现在执行？",'确认操作','YesNo','Warning') -eq 'Yes'
}
function Open-ManagerPath([string]$path) {
  if ($path -and (Test-Path -LiteralPath $path)) { Start-Process -FilePath $path }
  else { Write-ManagerLog ('文件或目录不存在：' + $path) }
}
(Ui 'StartDesktopBtn').Add_Click({ if (Confirm-Network '将启动 Codex，并准备原生远程入口；已打开的桌面会保持运行。') { Manager-Request @{action='start-desktop';confirmNetwork=$true} } })
(Ui 'StartServiceBtn').Add_Click({ Manager-Request @{action='start-service'} })
(Ui 'RefreshBtn').Add_Click({ Manager-Request @{action='status'} })
(Ui 'OpenWebBtn').Add_Click({
  $port = 4317
  if ($script:managerHome) { $cfg = Get-Content -Raw -LiteralPath (Join-Path $script:managerData 'connector.json') | ConvertFrom-Json; if ($cfg.port) {$port=[int]$cfg.port} }
  Start-Process ('http://127.0.0.1:' + $port + '/')
})
(Ui 'CheckUpdateBtn').Add_Click({ Manager-Request @{action='check-update'} })
(Ui 'InstallUpdateBtn').Add_Click({ if (Confirm-Network '将检查并安装连接器更新；有运行任务时会暂缓。') { Manager-Request @{action='update';confirmNetwork=$true} } })
(Ui 'RecoverBtn').Add_Click({ if (Confirm-Network '将恢复远程入口，不重启 Codex。') { Manager-Request @{action='recover';confirmNetwork=$true} } })
(Ui 'OpenLogsBtn').Add_Click({ Open-ManagerPath $script:managerData })
(Ui 'AccountSwitcherBtn').Add_Click({ Manager-Request @{action='open-account-switcher'} })
(Ui 'EnableExecutorBtn').Add_Click({ $row=(Ui 'ExecutorsGrid').SelectedItem; if ($row) { Manager-Request @{action='toggle-executor';id=$row.id;enabled=$true} } else { Write-ManagerLog '请先选择一个执行器。' } })
(Ui 'DisableExecutorBtn').Add_Click({ $row=(Ui 'ExecutorsGrid').SelectedItem; if ($row) { Manager-Request @{action='toggle-executor';id=$row.id;enabled=$false} } else { Write-ManagerLog '请先选择一个执行器。' } })
(Ui 'ExecutorsGrid').Add_SelectionChanged({ $row=(Ui 'ExecutorsGrid').SelectedItem; if ($row) { (Ui 'ExecutorPath').Text=if ($row.command) {$row.command} else {'API 执行器；密钥值不在此窗口显示。'} } })
(Ui 'OpenExecutorBtn').Add_Click({ $row=(Ui 'ExecutorsGrid').SelectedItem; if ($row.command) { Open-ManagerPath (Split-Path -Parent $row.command) } else { Write-ManagerLog '所选执行器没有本地程序路径。' } })
(Ui 'OpenConfigBtn').Add_Click({ if ($script:managerLast.executors.configured) { Start-Process 'notepad.exe' -ArgumentList ('"' + $script:managerLast.executors.file + '"') } else { Write-ManagerLog '尚未创建模型路由配置，请先完成执行器配置。' } })
(Ui 'OpenRecordsBtn').Add_Click({ Open-ManagerPath (Join-Path $script:managerData 'agent-runs') })
(Ui 'PasswordSaveBtn').Add_Click({
  $password=(Ui 'NewPassword').Password; $confirmation=(Ui 'ConfirmNewPassword').Password
  if (-not $password -or -not $confirmation) { Write-ManagerLog '请输入两次重启密码。'; return }
  if ($password.Length -lt 6 -or $password.Length -gt 128) { Write-ManagerLog '重启密码需要 6–128 个字符。'; return }
  if ($password -cne $confirmation) { Write-ManagerLog '两次密码不一致，密码没有修改。'; return }
  (Ui 'NewPassword').Clear(); (Ui 'ConfirmNewPassword').Clear()
  Manager-Request @{action='set-password';password=$password;confirmation=$confirmation}
})
(Ui 'RestartBtn').Add_Click({
  $scope=(Ui 'RestartScope').SelectedItem.Tag
  if ($scope -eq 'desktop' -and -not (Ui 'ConfirmDesktop').IsChecked) { Write-ManagerLog '请先勾选确认中断所有 Codex 任务。'; return }
  if (-not (Ui 'RestartPassword').Password) { Write-ManagerLog '请输入重启密码。'; return }
  $message=if ($scope -eq 'desktop') {'将强制重启 Codex 和服务，所有当前 Codex 任务都会中断。'} else {'将重启远程服务以加载本机代码；Codex 桌面保持打开。'}
  if (Confirm-Network $message) {
    $request=@{action='restart';scope=$scope;password=(Ui 'RestartPassword').Password;confirmDesktop=[bool](Ui 'ConfirmDesktop').IsChecked;confirmNetwork=$true}
    (Ui 'RestartPassword').Clear(); Manager-Request $request; $request.password=$null
  }
})
if (-not $ConnectorHome) {
  (Ui 'CheckUpdateBtn').Content='查看本机发布版本'; (Ui 'InstallUpdateBtn').Visibility='Collapsed'
  (Ui 'UpdateHint').Text='这里使用本机工作目录。到“重启与恢复”选择仅重启服务，即可加载本机现有代码。Codex 更新后的安装路径由启动器自动识别。'
} else { (Ui 'UpdateHint').Text='更新源离线时继续使用已有版本；仍有运行任务或待处理请求时暂缓安装。' }
$script:managerTimer = New-Object Windows.Threading.DispatcherTimer
$script:managerTimer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:managerTimer.Add_Tick({
  if ($script:managerTask -and $script:managerTask.Process.HasExited -and $script:managerTask.Output.IsCompleted -and $script:managerTask.Error.IsCompleted) {
    $task=$script:managerTask; $script:managerTask=$null
    try {
      $value=$task.Output.Result.Trim() | ConvertFrom-Json
      if (-not $value.ok) { throw $value.error }
      if ($task.Action -eq 'status') { Render-ManagerStatus $value.result; $script:managerLastStatus=[DateTime]::UtcNow; if ($VerifyStatusOnly) { $script:managerVerifyComplete=$true } }
      else {
        Write-ManagerLog $value.result.message
        if ($task.Action -eq 'check-update') {
          (Ui 'UpdateHint').Text=$value.result.message
          $release=$value.result.update.release
          (Ui 'ReleaseNotes').Visibility=if ($release) {'Visible'} else {'Collapsed'}
          (Ui 'ReleaseNotes').Text=if ($release) {$release.name+"`r`n`r`n"+$release.notes} else {''}
        }
        $script:managerLastStatus=[DateTime]::UtcNow.AddSeconds(-20)
      }
      (Ui 'OperationStatus').Text=if ($task.Action -eq 'status') {'状态已更新。窗口关闭后不再检查。'} else {'操作已返回，正在刷新状态。'}
    } catch { Write-ManagerLog $_.Exception.Message; (Ui 'OperationStatus').Text='操作未完成，具体原因见下方记录。'; $script:managerLastStatus=[DateTime]::UtcNow; if ($VerifyStatusOnly) { $script:managerVerificationError=$_.ToString(); $script:managerVerifyComplete=$true } }
    finally { $task.Process.Dispose(); foreach ($name in $script:managerControls) { (Ui $name).IsEnabled=$true } }
  }
  if (-not $script:managerTask -and ([DateTime]::UtcNow-$script:managerLastStatus).TotalSeconds -ge 12) { Manager-Request @{action='status'} }
})
$script:managerWindow.Add_Closing({
  param($sender,$eventArgs)
  if ($script:managerTask -and $script:managerTask.Action -ne 'status') {
    $eventArgs.Cancel=$true; Write-ManagerLog '操作仍在处理，请等待返回后关闭窗口。'; return
  }
  $script:managerClosing=$true; $script:managerTimer.Stop(); (Ui 'RestartPassword').Clear()
})
$script:managerWindow.Add_ContentRendered({ Manager-Request @{action='status'}; $script:managerTimer.Start() })
if ($VerifyStatusOnly) { $script:managerWindow.ShowInTaskbar=$false; $script:managerWindow.ShowActivated=$false; $script:managerWindow.Opacity=0 }
if ($VerifyStatusOnly) {
  $script:managerWindow.Show()
  while (-not $script:managerVerifyComplete -and ([DateTime]::UtcNow-$script:managerVerifyStarted).TotalSeconds -lt 15) {
    $frame=New-Object Windows.Threading.DispatcherFrame
    $script:managerWindow.Dispatcher.BeginInvoke([Windows.Threading.DispatcherPriority]::Background,[Action]{ $frame.Continue=$false }) | Out-Null
    [Windows.Threading.Dispatcher]::PushFrame($frame)
    [Threading.Thread]::Sleep(20)
  }
  $script:managerWindow.Close()
} else { $null=$script:managerWindow.ShowDialog() }
if ($VerifyStatusOnly) {
  if ($script:managerVerificationError) { throw $script:managerVerificationError }
  if (-not $script:managerLast) { throw 'Management status was not rendered' }
  try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch {} 
  @{ verified=$true; topStatus=(Ui 'TopStatus').Text; versionText=(Ui 'VersionText').Text; healthRows=(Ui 'HealthRows').Items.Count; maintenanceHint=(Ui 'MaintenanceHint').Text } | ConvertTo-Json -Compress
}
