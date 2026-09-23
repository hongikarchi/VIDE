using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    // A policy against common accidental side effects, not an OS sandbox.
    internal static class SdkCompiler
    {
        internal static MethodInfo Compile(string body, out string code, out string[] diagnostics)
        {
            string source = "using System; using System.Linq; using ZwSoft.ZwCAD.DatabaseServices; using ZwSoft.ZwCAD.Geometry; public static class TaskCode { public static object Run(Database db, Transaction tr) { " + body + "\nreturn null; } }";
            var tree = CSharpSyntaxTree.ParseText(source);
            var references = new[] { typeof(object).Assembly, typeof(Enumerable).Assembly, typeof(Database).Assembly, typeof(ZwSoft.ZwCAD.Runtime.CommandMethodAttribute).Assembly }
                .Distinct().Select(a => MetadataReference.CreateFromFile(a.Location));
            var compilation = CSharpCompilation.Create("VideTask_" + Guid.NewGuid().ToString("N"), new[] { tree }, references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: false));
            diagnostics = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Take(12).Select(d => d.ToString()).ToArray();
            code = "COMPILE_ERROR";
            if (diagnostics.Length != 0) return null;
            var root = tree.GetRoot();
            var declarations = root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().ToArray();
            var methods = root.DescendantNodes().OfType<MethodDeclarationSyntax>().ToArray();
            var denied = new System.Collections.Generic.HashSet<string>();
            if (declarations.Length != 1 || declarations[0].Identifier.ValueText != "TaskCode" || methods.Length != 1 || methods[0].Identifier.ValueText != "Run" ||
                root.DescendantNodes().Any(n => n is AttributeSyntax || n is FieldDeclarationSyntax || n is ConstructorDeclarationSyntax || n is PropertyDeclarationSyntax || n is DestructorDeclarationSyntax || n is TypeOfExpressionSyntax || n is UnsafeStatementSyntax))
                denied.Add("Only the supplied method body is allowed.");
            var model = compilation.GetSemanticModel(tree);
            foreach (var expression in root.DescendantNodes().OfType<ExpressionSyntax>())
            {
                if (model.GetTypeInfo(expression).Type?.TypeKind == TypeKind.Dynamic) denied.Add("Dynamic dispatch is not allowed.");
                var symbol = model.GetSymbolInfo(expression).Symbol;
                if (symbol == null) continue;
                var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
                string ns = type?.ContainingNamespace?.IsGlobalNamespace == true ? "" : type?.ContainingNamespace?.ToDisplayString() ?? "";
                string name = type?.ToDisplayString() ?? "";
                bool system = ns == "System" || ns == "System.Linq" || ns == "System.Collections" || ns.StartsWith("System.Collections.", StringComparison.Ordinal);
                bool sdk = ns == "ZwSoft.ZwCAD.DatabaseServices" || ns == "ZwSoft.ZwCAD.Geometry" || ns == "ZwSoft.ZwCAD.Colors" || (name == "ZwSoft.ZwCAD.Runtime.RXObject" && symbol.Name == "Clone");
                if ((ns.Length != 0 && !system && !sdk) ||
                    new[] { "System.Environment", "System.AppDomain", "System.Type", "System.Activator", "System.Console", "System.GC" }.Contains(name) ||
                    (name == "object" && symbol.Name == "GetType") ||
                    (name == "ZwSoft.ZwCAD.DatabaseServices.Database" && (symbol.IsStatic || new[] { "SaveAs", "ReadDwgFile", "ReadDxfFile", "DxfOut", "DxfIn", "CloseInput", "Dispose" }.Contains(symbol.Name))) ||
                    (name == "ZwSoft.ZwCAD.DatabaseServices.Transaction" && new[] { "Commit", "Abort", "Dispose" }.Contains(symbol.Name)))
                    denied.Add("API not permitted: " + name + "." + symbol.Name);
            }
            diagnostics = denied.Take(12).ToArray();
            code = "CODE_POLICY_REJECTED";
            if (diagnostics.Length != 0) return null;
            using (var output = new MemoryStream())
            {
                var emitted = compilation.Emit(output);
                if (!emitted.Success)
                {
                    code = "COMPILE_ERROR";
                    diagnostics = emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(12).Select(d => d.ToString()).ToArray();
                    return null;
                }
                code = null;
                return Assembly.Load(output.ToArray()).GetType("TaskCode").GetMethod("Run");
            }
        }
    }
}
