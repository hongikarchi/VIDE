using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad
{
    // A policy against common accidental side effects, not an OS sandbox. Since ADR-031 8 (T-187) it
    // keeps only the escape rules, like the Rhino worker's CodePolicy: files, network, processes,
    // reflection and runtime, dynamic loading, the application and its documents (open, save, close,
    // active document), VIDE's transaction and undo. Everything else in ZwSoft.ZwCAD.* and System.* passes.
    internal static class SdkCompiler
    {
        private static readonly string[] DeniedNamespaces =
        {
            "System.IO", "System.Net", "System.Reflection", "System.Diagnostics", "System.Runtime", "Microsoft.Win32", "Microsoft.CodeAnalysis", "Vide",
            // Application, DocumentManager and Document open, close, save and switch drawings; plotting and publishing write files.
            "ZwSoft.ZwCAD.ApplicationServices", "ZwSoft.ZwCAD.PlottingServices", "ZwSoft.ZwCAD.Publishing", "ZwSoft.ZwCAD.Internal",
        };

        private static readonly string[] DeniedTypes =
        {
            "System.Environment", "System.AppDomain", "System.Type", "System.Activator", "System.Console", "System.GC",
            // Module loading, native interop and global overrules outlive the run.
            "ZwSoft.ZwCAD.Runtime.DynamicLinker", "ZwSoft.ZwCAD.Runtime.ExtensionLoader", "ZwSoft.ZwCAD.Runtime.Interop", "ZwSoft.ZwCAD.Runtime.Marshaler", "ZwSoft.ZwCAD.Runtime.Overrule",
            // The working database is the active drawing, not the supplied db.
            "ZwSoft.ZwCAD.DatabaseServices.HostApplicationServices",
        };

        // Reading/writing other files and VIDE's undo; the rest of Database (tables, Purge, Wblock, linetype files) passes.
        private static readonly string[] DeniedDatabaseMembers =
        {
            "Save", "SaveAs", "ReadDwgFile", "ReadDxfFile", "DxfOut", "DxfIn", "CloseInput", "Dispose", "AttachXref", "OverlayXref",
            "StartUndoRecord", "Undo", "DisableUndoRecording",
        };

        private const string DatabaseType = "ZwSoft.ZwCAD.DatabaseServices.Database";
        private const string TransactionType = "ZwSoft.ZwCAD.DatabaseServices.Transaction";

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
            diagnostics = Check(compilation);
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

        internal static string[] Check(CSharpCompilation compilation)
        {
            var denied = new HashSet<string>();
            foreach (var tree in compilation.SyntaxTrees)
            {
                var root = tree.GetRoot();
                var model = compilation.GetSemanticModel(tree);
                var declarations = root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().ToArray();
                var methods = root.DescendantNodes().OfType<MethodDeclarationSyntax>().ToArray();
                if (declarations.Length != 1 || declarations[0].Identifier.ValueText != "TaskCode" || methods.Length != 1 || methods[0].Identifier.ValueText != "Run" ||
                    root.DescendantNodes().Any(n => n is AttributeSyntax || n is FieldDeclarationSyntax || n is ConstructorDeclarationSyntax || n is PropertyDeclarationSyntax || n is DestructorDeclarationSyntax ||
                        n is TypeOfExpressionSyntax || n is UnsafeStatementSyntax || n is PointerTypeSyntax || n is FunctionPointerTypeSyntax))
                    denied.Add("Only the supplied method body is allowed.");
                // `using (tr)` disposes VIDE's transaction; `using (var side = new Database(...))` is the caller's own.
                foreach (var statement in root.DescendantNodes().OfType<UsingStatementSyntax>())
                    if (statement.Expression != null && IsOrDerives(model.GetTypeInfo(statement.Expression).Type, TransactionType))
                        denied.Add("API not permitted: " + TransactionType + ".Dispose");
                foreach (var expression in root.DescendantNodes().OfType<ExpressionSyntax>())
                {
                    if (model.GetTypeInfo(expression).Type?.TypeKind == TypeKind.Dynamic) denied.Add("Dynamic dispatch is not allowed.");
                    var info = model.GetSymbolInfo(expression);
                    var receiver = expression is MemberAccessExpressionSyntax access ? model.GetTypeInfo(access.Expression).Type : null;
                    foreach (var symbol in info.Symbol == null ? info.CandidateSymbols : ImmutableArray.Create(info.Symbol))
                    {
                        var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
                        string ns = (type?.ContainingNamespace ?? symbol.ContainingNamespace)?.ToDisplayString() ?? "";
                        string name = type?.ToDisplayString() ?? "";
                        // Reading a type's name (entity.GetType().Name) grants nothing; other Type/reflection members stay denied.
                        if ((symbol.Name == "GetType" && name == "object") || ((symbol.Name == "Name" || symbol.Name == "FullName") && (name == "System.Type" || name == "System.Reflection.MemberInfo")))
                            continue;
                        // Dispose is inherited from DisposableWrapper, so the receiver decides whether it is VIDE's db or tr.
                        bool database = name == DatabaseType || (receiver != null && IsOrDerives(receiver, DatabaseType));
                        bool transaction = name == TransactionType || (receiver != null && IsOrDerives(receiver, TransactionType));
                        if (DeniedNamespaces.Any(prefix => ns == prefix || ns.StartsWith(prefix + ".", StringComparison.Ordinal)) ||
                            DeniedTypes.Contains(name) ||
                            (database && DeniedDatabaseMembers.Contains(symbol.Name)) ||
                            // VIDE commits or discards the transaction after the run.
                            (transaction && (symbol.Name == "Commit" || symbol.Name == "Abort" || symbol.Name == "Dispose")))
                            denied.Add("API not permitted: " + (name.Length > 0 ? name + "." : ns + ".") + symbol.Name);
                    }
                }
            }
            return denied.Take(12).ToArray();
        }

        private static bool IsOrDerives(ITypeSymbol type, string fullName)
        {
            for (var current = type; current != null; current = current.BaseType)
                if (current.ToDisplayString() == fullName) return true;
            return false;
        }
    }
}
