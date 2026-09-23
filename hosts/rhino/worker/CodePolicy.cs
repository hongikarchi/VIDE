using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Vide.Worker;

// Defense in depth for generated method bodies, not an OS security boundary.
internal static class CodePolicy
{
    private static readonly string[] DeniedNamespaces = ["System.IO", "System.Net", "System.Reflection", "System.Diagnostics", "System.Runtime", "System.Threading", "Microsoft.Win32", "Microsoft.CodeAnalysis", "Rhino.FileIO", "Rhino.Runtime", "Rhino.PlugIns", "Rhino.Commands", "Rhino.UI", "Rhino.ApplicationSettings", "Vide"];
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
                    if ((!objectTableRead && DeniedNamespaces.Any(prefix => ns == prefix || ns.StartsWith(prefix + ".", StringComparison.Ordinal))) ||
                        name is "System.Environment" or "System.AppDomain" or "System.Type" or "System.Activator" or "System.Console" or "Rhino.RhinoApp" ||
                        symbol.Name == "GetType" && name == "object" ||
                        name == "Rhino.RhinoDoc" && (symbol.IsStatic || symbol.Name is "Dispose" or "Close" or "Write3dmFile" or "WriteFile" or "ReadFile" or "Import" or "Export"))
                        failures.Add("API not permitted: " + (name.Length > 0 ? name + "." : ns + ".") + symbol.Name);
                }
            }
        }
        return failures.Take(12).ToArray();
    }
}
