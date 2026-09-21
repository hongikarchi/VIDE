import {DomainError} from './store.ts';
export class ReviewNotes{
 constructor(store,reviews){this.store=store;this.reviews=reviews;store.db.exec('CREATE TABLE IF NOT EXISTS review_notes(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), reviewId TEXT NOT NULL REFERENCES review_snapshots(id), requestId TEXT NOT NULL, objectId TEXT, body TEXT NOT NULL, createdAt TEXT NOT NULL)');}
 list(projectId,reviewId){this.reviews.get(projectId,reviewId);return this.store.db.prepare('SELECT * FROM review_notes WHERE projectId=? AND reviewId=? ORDER BY rowid').all(projectId,reviewId);}
 create(projectId,reviewId,input){
  const review=this.reviews.get(projectId,reviewId);
  if(!input||typeof input.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(input.id)||typeof input.body!=='string'||!input.body.trim()||input.body.length>4000||!(input.objectId===null||review.payload.model.some(object=>object.id===input.objectId)))throw new DomainError('INVALID_INPUT');
  const existing=this.store.db.prepare('SELECT * FROM review_notes WHERE id=?').get(input.id);
  if(existing){if(existing.projectId!==projectId||existing.reviewId!==reviewId||existing.body!==input.body||existing.objectId!==input.objectId)throw new DomainError('REVISION_CONFLICT');return existing;}
  if(this.list(projectId,reviewId).length>=1000)throw new DomainError('INPUT_TOO_LARGE');
  this.store.db.prepare('INSERT INTO review_notes VALUES(?,?,?,?,?,?,?)').run(input.id,projectId,reviewId,review.requestId,input.objectId,input.body,new Date().toISOString());
  return this.store.db.prepare('SELECT * FROM review_notes WHERE id=?').get(input.id);
 }
}
