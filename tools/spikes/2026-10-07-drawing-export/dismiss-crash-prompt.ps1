param([int]$ProcessId)
# Clicks "No" on ZWCAD's "previous run crashed, send report?" prompt, only in the given
# (spike-owned) process. A pending crash report blocks every hidden ZWCAD start until answered.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files in the ANSI code page.
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public static class VideCrashPrompt{public delegate bool P(IntPtr h,IntPtr l);
[DllImport("user32.dll")]static extern bool EnumWindows(P p,IntPtr l);
[DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr w,P p,IntPtr l);
[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
public static bool ClickNo(uint target){bool done=false;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);var c=new StringBuilder(64);GetClassName(h,c,64);
if(p==target&&c.ToString()=="#32770"){EnumChildWindows(h,(k,m)=>{var s=new StringBuilder(256);GetWindowText(k,s,256);
if(s.ToString()==new string(new char[]{(char)0xC544,(char)0xB2C8,(char)0xC624})){SendMessage(k,0x00F5,IntPtr.Zero,IntPtr.Zero);done=true;}return true;},IntPtr.Zero);}return true;},IntPtr.Zero);return done;}}
"@
if ([VideCrashPrompt]::ClickNo([uint32]$ProcessId)) { 'dismissed' } else { 'none' }
