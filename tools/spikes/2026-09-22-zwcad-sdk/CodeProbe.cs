using System;
using System.CodeDom.Compiler;
using System.IO;
using Microsoft.CSharp;
using ZwSoft.ZwCAD.DatabaseServices;
using ZwSoft.ZwCAD.Runtime;

internal static class VideCodeProbe
{
    // This is a compiler compatibility experiment, not an untrusted-code security sandbox.
    internal static object Run(Database database, string code, string temporaryDirectory)
    {
        if (String.IsNullOrWhiteSpace(code) || code.Length > 65536) throw new InvalidOperationException("INVALID_CODE");
        string source = "using System; using System.Linq; using ZwSoft.ZwCAD.DatabaseServices; using ZwSoft.ZwCAD.Geometry; public static class TaskCode { public static object Run(Database db, Transaction tr) { " + code + "\nreturn null; } }";
        using (CSharpCodeProvider compiler = new CSharpCodeProvider())
        using (TempFileCollection temporaryFiles = new TempFileCollection(temporaryDirectory, false))
        {
            CompilerParameters options = new CompilerParameters();
            options.GenerateInMemory = true;
            options.GenerateExecutable = false;
            options.TempFiles = temporaryFiles;
            options.CompilerOptions = "/optimize";
            options.ReferencedAssemblies.Add("System.dll");
            options.ReferencedAssemblies.Add("System.Core.dll");
            options.ReferencedAssemblies.Add(typeof(Database).Assembly.Location);
            options.ReferencedAssemblies.Add(typeof(CommandMethodAttribute).Assembly.Location);
            CompilerResults result = compiler.CompileAssemblyFromSource(options, source);
            if (result.Errors.HasErrors)
            {
                string message = "COMPILE_FAILED";
                foreach (CompilerError error in result.Errors) if (!error.IsWarning) message += "\n" + error.ErrorNumber + ": " + error.ErrorText;
                throw new InvalidOperationException(message);
            }
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                object value = result.CompiledAssembly.GetType("TaskCode").GetMethod("Run").Invoke(null, new object[] { database, transaction });
                transaction.Commit();
                return value;
            }
        }
    }
}
