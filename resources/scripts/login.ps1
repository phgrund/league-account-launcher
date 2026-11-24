param (
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [long]$NotBefore = 0,
    [switch]$Minimize,
    [switch]$PlayLeague,
    [long]$StartedBefore = 0
)

$ErrorActionPreference = 'Stop'

# Text goes only to the focused HWND belonging to the verified Riot window.
# SendKeys is reserved for Ctrl+A and Enter, which contain no credentials.
$windowApi = @'
using System;
using System.Runtime.InteropServices;

public static class RiotLoginWindow {
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessage(
        IntPtr window, uint message, UIntPtr key, IntPtr repeat);

    public static void Activate(IntPtr window) {
        if (IsIconic(window)) ShowWindowAsync(window, 9);
        if (GetForegroundWindow() == window || SetForegroundWindow(window)) return;
        uint process;
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out process);
        uint current = GetCurrentThreadId();
        if (foreground == 0 || foreground == current || !AttachThreadInput(current, foreground, true)) return;
        try { SetForegroundWindow(window); }
        finally { AttachThreadInput(current, foreground, false); }
    }

    public static void Minimize(IntPtr window) {
        ShowWindowAsync(window, 6);
    }

    public static bool WriteText(IntPtr window, string text) {
        if (GetForegroundWindow() != window || string.IsNullOrEmpty(text)) return false;
        foreach (char character in text) {
            if (char.IsControl(character)) return false;
        }
        uint owner, focusOwner;
        uint thread = GetWindowThreadProcessId(window, out owner);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (thread == 0 || !GetGUIThreadInfo(thread, ref info) || info.Focus == IntPtr.Zero ||
            GetAncestor(info.Focus, 2) != window ||
            GetWindowThreadProcessId(info.Focus, out focusOwner) == 0 || focusOwner != owner) return false;

        foreach (char character in text) {
            if (!PostMessage(info.Focus, 0x0102, new UIntPtr((uint)character), new IntPtr(1))) return false;
        }
        return true;
    }
}
'@

function Find-RiotLogin {
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $editType = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    $checkboxType = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::CheckBox)

    foreach ($client in (Get-Process -Name 'Riot Client', 'RiotClientUx' -ErrorAction SilentlyContinue)) {
        try {
            if (-not $client.Path -or -not $client.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if ($client.StartTime.ToUniversalTime() -lt $earliest -or $client.MainWindowHandle -eq 0) { continue }

            $handle = $client.MainWindowHandle
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $fields = @($root.FindAll($scope, $editType) | Where-Object {
                -not $_.Current.IsOffscreen -and $_.Current.IsEnabled
            })
            $users = @($fields | Where-Object { -not $_.Current.IsPassword })
            $passwords = @($fields | Where-Object { $_.Current.IsPassword })
            if ($users.Count -ne 1 -or $passwords.Count -ne 1) { continue }

            $remember = @($root.FindAll($scope, $checkboxType) | Where-Object {
                $_.Current.AutomationId -eq 'remember-me' -or
                $_.Current.Name -match '^(stay signed in|keep me signed in|continuar conectado|manter conex.o|manter sess.o iniciada)$'
            })
            return @{
                Window = $handle
                User = $users[0]
                Password = $passwords[0]
                Remember = $remember
            }
        } catch {
            # The Riot Client can replace its window while it loads.
        }
    }
}

function Test-RiotFocus($window, $field) {
    try {
        return [RiotLoginWindow]::GetForegroundWindow() -eq $window -and $field.Current.HasKeyboardFocus
    } catch {
        return $false
    }
}

function Invoke-LeaguePlayButton {
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $element = [System.Windows.Automation.AutomationElement]
    $buttonType = New-Object System.Windows.Automation.PropertyCondition(
        $element::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $textType = New-Object System.Windows.Automation.PropertyCondition(
        $element::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $leagueName = New-Object System.Windows.Automation.PropertyCondition($element::NameProperty, 'League of Legends')
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $openedLeague = $false

    do {
        foreach ($client in (Get-Process -Name 'Riot Client', 'RiotClientUx' -ErrorAction SilentlyContinue)) {
            try {
                if (-not $client.Path -or -not $client.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                    $client.MainWindowHandle -eq 0) { continue }
                $handle = $client.MainWindowHandle
                [RiotLoginWindow]::Activate($handle)
                $root = $element::FromHandle($handle)
                $buttons = @($root.FindAll($scope, $buttonType) | Where-Object {
                    -not $_.Current.IsOffscreen -and $_.Current.IsEnabled
                })
                $play = @($buttons | Where-Object { $_.Current.Name -match '^(play|jogar|jouer|spielen|jugar)(?:\s+league of legends)?$' })
                $league = @($root.FindAll($scope, $leagueName) | Where-Object { -not $_.Current.IsOffscreen })
                $navigate = @($league | Where-Object {
                    $_.Current.IsEnabled -and $_.Current.ControlType -in @(
                        [System.Windows.Automation.ControlType]::Button,
                        [System.Windows.Automation.ControlType]::Hyperlink,
                        [System.Windows.Automation.ControlType]::TabItem
                    )
                })

                if (-not $openedLeague -and $navigate.Count -eq 1) {
                    $navigationPattern = $null
                    if ($navigate[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$navigationPattern)) {
                        $navigationPattern.Invoke()
                        $openedLeague = $true
                        continue
                    }
                    if ($navigate[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$navigationPattern)) {
                        $navigationPattern.Select()
                        $openedLeague = $true
                        continue
                    }
                }

                # Accept a product-specific Play label, a verified navigation,
                # or a visible League heading/logo in the content.
                $leagueContent = @($league | Where-Object {
                    $_.Current.ControlType -in @(
                        [System.Windows.Automation.ControlType]::Text,
                        [System.Windows.Automation.ControlType]::Image
                    )
                })
                if (-not $openedLeague -and -not $leagueContent.Count -and $play.Count -eq 1) {
                    $leagueContent = @($root.FindAll($scope, $textType) | Where-Object {
                        -not $_.Current.IsOffscreen -and $_.Current.Name -match '^league of legends\s+\S.*\p{L}'
                    })
                }
                if ($play.Count -ne 1 -or
                    (-not $openedLeague -and -not $leagueContent.Count -and $play[0].Current.Name -notmatch 'league of legends$')) { continue }
                $play[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                return $true
            } catch {
                # Riot can replace or update its game page while loading.
            }
        }
        Start-Sleep -Milliseconds 350
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Set-RiotFieldFocus($window, $field) {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        [RiotLoginWindow]::Activate($window)
        try { $field.SetFocus() } catch { }
        Start-Sleep -Milliseconds 150
        if (Test-RiotFocus $window $field) { return $true }
    }
    return $false
}

try {
    Add-Type -TypeDefinition $windowApi
    $installPrefix = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
    if ($Minimize) {
        $cutoff = [DateTimeOffset]::FromUnixTimeMilliseconds($StartedBefore).UtcDateTime
        foreach ($client in (Get-Process -Name 'Riot Client', 'RiotClientUx' -ErrorAction SilentlyContinue)) {
            if ($client.MainWindowHandle -ne 0 -and $client.Path -and
                $client.StartTime.ToUniversalTime() -le $cutoff -and
                $client.Path.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                [RiotLoginWindow]::Minimize($client.MainWindowHandle)
            }
        }
        exit 0
    }

    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
    if ($PlayLeague) {
        if (Invoke-LeaguePlayButton) { exit 0 }
        exit 1
    }

    $earliest = [DateTimeOffset]::FromUnixTimeMilliseconds($NotBefore).UtcDateTime.AddSeconds(-2)
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $form = Find-RiotLogin
        if ($form) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $form) { exit 1 }

    $encoded = [Console]::In.ReadLine()
    if (-not $encoded) { exit 4 }
    $bytes = [Convert]::FromBase64String($encoded)
    $encoded = $null
    try {
        $credential = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        if ($form.Remember.Count -eq 1) {
            try {
                $toggle = $null
                if ($form.Remember[0].TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle) -and
                    $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) {
                    $toggle.Toggle()
                }
            } catch { }
        }

        if (-not (Set-RiotFieldFocus $form.Window $form.User)) { exit 2 }
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        if (-not (Test-RiotFocus $form.Window $form.User)) { exit 2 }
        if (-not [RiotLoginWindow]::WriteText($form.Window, $credential.username)) { exit 3 }
        Start-Sleep -Milliseconds 200

        if (-not (Set-RiotFieldFocus $form.Window $form.Password)) { exit 2 }
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        if (-not (Test-RiotFocus $form.Window $form.Password)) { exit 2 }
        if (-not [RiotLoginWindow]::WriteText($form.Window, $credential.password)) { exit 3 }
        Start-Sleep -Milliseconds 300

        # Riot's login form accepts Enter even when the submit button has no
        # accessible name. Verify focus on its password field before pressing it.
        if (-not (Test-RiotFocus $form.Window $form.Password)) { exit 2 }
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $credential = $null
    }
    exit 0
} catch {
    exit 4
}
