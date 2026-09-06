// Only restore DWM composition on windows owned by the launching Electron process.
using System;
using System.Runtime.InteropServices;

internal static class WindowMaterial {
    [StructLayout(LayoutKind.Sequential)] struct Margins { public int Left, Right, Top, Bottom; }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr window, ref Margins margins);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    static int Main(string[] args) {
        uint owner;
        if (args.Length != 1 || !uint.TryParse(args[0], out owner)) return 2;
        string line;
        while ((line = Console.ReadLine()) != null) {
            long value;
            var parts = line.Split(' ');
            if (parts.Length != 2 || !long.TryParse(parts[0], out value)) continue;
            var window = new IntPtr(value);
            uint actual;
            GetWindowThreadProcessId(window, out actual);
            if (actual != owner) { Console.WriteLine("denied"); continue; }
            // Chromium 为无边框最大化窗口设置的裁剪 region 会禁用 DWM backdrop。
            // 交还系统管理区域，保留原生最大化、贴边、工作区和恢复尺寸语义。
            SetWindowRgn(window, IntPtr.Zero, true);
            var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
            int dark = parts[1] == "dark" ? 1 : 0, backdrop = 3, caption = -2;
            DwmSetWindowAttribute(window, 20, ref dark, 4);
            DwmSetWindowAttribute(window, 35, ref caption, 4);
            DwmSetWindowAttribute(window, 38, ref backdrop, 4);
            Console.WriteLine(DwmExtendFrameIntoClientArea(window, ref margins));
        }
        return 0;
    }
}
