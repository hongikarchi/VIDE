using System;
using System.IO;
using System.Linq;
using System.Reflection;

namespace Vide.Zwcad
{
    internal static class CompilerDependencies
    {
        private static bool installed;
        internal static void Install()
        {
            if (installed) return;
            installed = true;
            // Plugin-local redirects: do not modify ZWCAD.exe.config or probe arbitrary paths.
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
        }
        private static Assembly Resolve(object sender, ResolveEventArgs args)
        {
            var requested = new AssemblyName(args.Name);
            string[] allowed = { "System.Runtime.CompilerServices.Unsafe", "System.Memory", "System.Buffers", "System.Collections.Immutable", "System.Reflection.Metadata", "System.Numerics.Vectors", "System.Threading.Tasks.Extensions", "System.Text.Encoding.CodePages", "Microsoft.CodeAnalysis", "Microsoft.CodeAnalysis.CSharp" };
            if (!allowed.Contains(requested.Name)) return null;
            string path = Path.Combine(Path.GetDirectoryName(typeof(CompilerDependencies).Assembly.Location), requested.Name + ".dll");
            if (!File.Exists(path)) return null;
            var actual = AssemblyName.GetAssemblyName(path);
            if (actual.Name != requested.Name || !actual.GetPublicKeyToken().SequenceEqual(requested.GetPublicKeyToken())) return null;
            return Assembly.LoadFrom(path);
        }
    }
}
