using System;
using System.Collections.Generic;
using System.Linq;
using ZwSoft.ZwCAD.ApplicationServices;
using ZwSoft.ZwCAD.DatabaseServices;

namespace Vide.Zwcad.Connection
{
    /// <summary>
    /// ADR-030: the VIDE link id is kept in the drawing itself (named object dictionary "VIDE_LINKS",
    /// one Xrecord per VIDE project), so Save As, a moved or renamed file and a restart keep the link.
    /// This is the one value the plugin writes into a user's drawing; writing it marks the drawing
    /// modified once and the user's next save keeps it.
    /// </summary>
    internal static class LinkIdStore
    {
        private const string Name = "VIDE_LINKS";

        private static string Text(Transaction tx, ObjectId id)
        {
            var record = tx.GetObject(id, OpenMode.ForRead) as Xrecord;
            var data = record?.Data?.AsArray();
            var value = data != null && data.Length > 0 ? data[0].Value as string : null;
            return String.IsNullOrEmpty(value) || value.Length > 100 ? null : value;
        }

        /// <summary>Every stored link id; the caller holds the document lock and a transaction.</summary>
        internal static string[] All(Database db, Transaction tx)
        {
            var nod = (DBDictionary)tx.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForRead);
            if (!nod.Contains(Name)) return new string[0];
            var links = (DBDictionary)tx.GetObject(nod.GetAt(Name), OpenMode.ForRead);
            var result = new List<string>();
            foreach (DBDictionaryEntry entry in links)
            {
                var value = Text(tx, entry.Value);
                if (value != null) result.Add(value);
            }
            return result.Take(50).ToArray();
        }

        internal static string Read(Document doc, string projectId)
        {
            using (doc.LockDocument())
            using (var tx = doc.Database.TransactionManager.StartTransaction())
            {
                var nod = (DBDictionary)tx.GetObject(doc.Database.NamedObjectsDictionaryId, OpenMode.ForRead);
                if (!nod.Contains(Name)) return null;
                var links = (DBDictionary)tx.GetObject(nod.GetAt(Name), OpenMode.ForRead);
                return links.Contains(projectId) ? Text(tx, links.GetAt(projectId)) : null;
            }
        }

        /// <summary>Stores the id; false when the drawing already holds it (nothing is modified).</summary>
        internal static bool Write(Document doc, string projectId, string linkId)
        {
            using (doc.LockDocument())
            using (var tx = doc.Database.TransactionManager.StartTransaction())
            {
                var nod = (DBDictionary)tx.GetObject(doc.Database.NamedObjectsDictionaryId, OpenMode.ForRead);
                DBDictionary links;
                if (nod.Contains(Name)) links = (DBDictionary)tx.GetObject(nod.GetAt(Name), OpenMode.ForWrite);
                else
                {
                    nod.UpgradeOpen();
                    links = new DBDictionary();
                    nod.SetAt(Name, links);
                    tx.AddNewlyCreatedDBObject(links, true);
                }
                var data = new ResultBuffer(new TypedValue((int)DxfCode.Text, linkId));
                if (links.Contains(projectId))
                {
                    if (Text(tx, links.GetAt(projectId)) == linkId) { tx.Commit(); return false; }
                    var record = (Xrecord)tx.GetObject(links.GetAt(projectId), OpenMode.ForWrite);
                    record.Data = data;
                }
                else
                {
                    var record = new Xrecord { Data = data };
                    links.SetAt(projectId, record);
                    tx.AddNewlyCreatedDBObject(record, true);
                }
                tx.Commit();
                return true;
            }
        }
    }
}
