using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Vide.Worker;

// Defense in depth for generated method bodies, not an OS security boundary. Since ADR-031 8
// (T-122) it keeps only the escape rules: files, network, processes, reflection and runtime,
// plug-ins, closing or saving the document, and VIDE's undo record. Threads, UI, application
// settings, commands' types and the console pass.
internal static class CodePolicy
{
    private static readonly string[] DeniedNamespaces = ["System.IO", "System.Net", "System.Reflection", "System.Diagnostics", "System.Runtime", "Microsoft.Win32", "Microsoft.CodeAnalysis", "Rhino.FileIO", "Rhino.Runtime", "Rhino.PlugIns", "Vide"];
    public static string[] Check(CSharpCompilation compilation)
    {
        var failures = new HashSet<string>();
        foreach (var tree in compilation.SyntaxTrees)
        {
            var root = tree.GetRoot();
            var model = compilation.GetSemanticModel(tree);
            var types = root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().ToArray();
            var methods = root.DescendantNodes().OfType<MethodDeclarationSyntax>().ToArray();
            if (types.Length != 1 || types[0].Identifier.ValueText != "TaskCode" || methods.Length != 1 || methods[0].Identifier.ValueText != "Run" ||
                root.DescendantNodes().Any(n => n is AttributeSyntax or FieldDeclarationSyntax or ConstructorDeclarationSyntax or PropertyDeclarationSyntax or DestructorDeclarationSyntax or UnsafeStatementSyntax or PointerTypeSyntax or FunctionPointerTypeSyntax or TypeOfExpressionSyntax))
                failures.Add("Only the supplied method body is allowed.");
            foreach (var expression in root.DescendantNodes().OfType<ExpressionSyntax>())
            {
                if (model.GetTypeInfo(expression).Type?.TypeKind == TypeKind.Dynamic) failures.Add("Dynamic dispatch is not allowed.");
                var info = model.GetSymbolInfo(expression);
                foreach (var symbol in info.Symbol is null ? info.CandidateSymbols : new[] { info.Symbol }.ToImmutableArray())
                {
                    var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
                    var ns = (type?.ContainingNamespace ?? symbol.ContainingNamespace)?.ToDisplayString() ?? "";
                    var name = type?.ToDisplayString() ?? "";
                    // Rhino object tables inherit these read-only members from FileIO despite performing no file I/O.
                    var objectTableRead = ns == "Rhino.FileIO" && type?.OriginalDefinition.Name == "CommonComponentTable" && symbol.Name is "Count" or "GetEnumerator";
                    // Reading a type's name (o.Geometry.GetType().Name) is common in queries and grants nothing;
                    // every other Type/reflection member stays denied.
                    var typeName = (symbol.Name == "GetType" && name == "object") ||
                        (symbol.Name is "Name" or "FullName" && name is "System.Type" or "System.Reflection.MemberInfo");
                    if (typeName) continue;
                    // Validity checks inherited from CommonObject (brep.IsValid) are read-only; the rest of Rhino.Runtime stays denied.
                    if (name == "Rhino.Runtime.CommonObject" && symbol.Name is "IsValid" or "IsValidWithLog" or "IsDocumentControlled") continue;
                    if ((!objectTableRead && DeniedNamespaces.Any(prefix => ns == prefix || ns.StartsWith(prefix + ".", StringComparison.Ordinal))) ||
                        name is "System.Environment" or "System.AppDomain" or "System.Type" or "System.Activator" ||
                        // RhinoApp runs commands and scripts or quits Rhino through these; the rest of it (WriteLine, version) passes.
                        name == "Rhino.RhinoApp" && symbol.Name is "RunScript" or "RunMenuScript" or "Exit" or "ExecuteCommand" or "SendKeystrokes" ||
                        symbol.Name == "GetType" && name == "object" ||
                        name == "Rhino.RhinoDoc" && (symbol.IsStatic || symbol.Name is "Dispose" or "Close" or "Write3dmFile" or "WriteFile" or "ReadFile" or "Import" or "Export" || symbol.Name.StartsWith("Save", StringComparison.Ordinal)) ||
                        // Undo is VIDE's safety net for direct execution; generated code never controls it.
                        name == "Rhino.RhinoDoc" && symbol.Name is "Undo" or "Redo" or "BeginUndoRecord" or "EndUndoRecord" or "ClearUndoRecords" or "AddCustomUndoEvent" or "UndoRecordingEnabled" ||
                        name == "Rhino.RhinoDocUndoRecord")
                        failures.Add("API not permitted: " + (name.Length > 0 ? name + "." : ns + ".") + symbol.Name);
                }
            }
        }
        return failures.Take(12).ToArray();
    }

    /// <summary>Whether the code calls a document table Purge/Compact, which undo cannot restore (direct-mode guard).</summary>
    /// <remarks>Only document tables (Rhino.DocObjects.Tables: LayerTable, InstanceDefinitionTable, ObjectTable, …) and RhinoDoc count.
    /// Geometry methods of the same name (Mesh.Compact, Brep.Compact) only tidy an in-memory object and are not purges.</remarks>
    public static bool Purges(CSharpCompilation compilation) => compilation.SyntaxTrees.Any(tree =>
    {
        var model = compilation.GetSemanticModel(tree);
        return tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Any(call =>
            model.GetSymbolInfo(call).Symbol is IMethodSymbol method && (method.Name.StartsWith("Purge", StringComparison.Ordinal) || method.Name == "Compact") &&
            IsDocumentTable(method.ContainingType));
    });

    private static bool IsDocumentTable(INamedTypeSymbol? type) =>
        type is not null && (type.ContainingNamespace.ToDisplayString() == "Rhino.DocObjects.Tables" || type.ToDisplayString() == "Rhino.RhinoDoc");
}
