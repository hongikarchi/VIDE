// Site admins' reports page (ADR-036, PLAN-34 T-158): opt-in error/performance reports from VIDE
// installs by day, version and kind, one report's summary, and a CSV of the filtered list. The API
// answers admins only (ADMIN_USERS); the page is linked from the top bar for them.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, message } from './api';

const summarySchema = z.object({
  rows: z.array(
    z.object({
      day: z.string(),
      version: z.string(),
      kind: z.string(),
      reports: z.number(),
      installs: z.number(),
      bytes: z.number().nullable(),
    }),
  ),
});
const reportsSchema = z.object({
  reports: z.array(
    z.object({
      id: z.string(),
      install_id: z.string(),
      version: z.string(),
      kind: z.string(),
      received_at: z.number(),
      day: z.string(),
      size: z.number(),
      payload: z.unknown(),
      brief: z.object({
        os: z.string(),
        errors: z.number(),
        topError: z.string(),
        exits: z.number(),
        truncated: z.boolean(),
      }),
    }),
  ),
  next: z.number().nullable(),
});
type Report = z.infer<typeof reportsSchema>['reports'][number];

export function Reports() {
  const [day, setDay] = useState(''),
    [version, setVersion] = useState(''),
    [kind, setKind] = useState(''),
    [summary, setSummary] = useState<z.infer<typeof summarySchema>['rows']>([]),
    [reports, setReports] = useState<Report[]>([]),
    [open, setOpen] = useState(''),
    [status, setStatus] = useState('');
  const query = useCallback(() => {
    const params = new URLSearchParams();
    if (day) params.set('day', day);
    if (version.trim()) params.set('version', version.trim());
    if (kind) params.set('kind', kind);
    const text = params.toString();
    return text ? '?' + text : '';
  }, [day, version, kind]);
  const refresh = useCallback(async () => {
    setStatus('');
    try {
      setSummary(summarySchema.parse(await api('/admin/telemetry/summary' + query())).rows);
      setReports(reportsSchema.parse(await api('/admin/telemetry/reports' + query())).reports);
    } catch (error) {
      setStatus(message(error));
    }
  }, [query]);
  useEffect(() => {
    void refresh();
    // Filters apply with [보기]; the first load shows everything.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="reports-page" aria-label="오류·성능 보고">
      <h1>오류·성능 보고</h1>
      <p className="reports-note">
        사용자가 동의한 설치에서 받은 이름 없는 요약입니다. 설치 번호는 무작위이며 계정과 연결되지
        않습니다.
      </p>
      <form
        className="reports-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label>
          날짜
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label>
          버전
          <input
            value={version}
            placeholder="예: 0.2.21"
            onChange={(e) => setVersion(e.target.value)}
          />
        </label>
        <label>
          종류
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">전체</option>
            <option value="summary">요약</option>
          </select>
        </label>
        <button className="primary">보기</button>
        <a className="reports-csv" href={'/api/admin/telemetry/reports.csv' + query()} download>
          CSV 내려받기
        </a>
      </form>
      {status ? (
        <p role="alert" className="status">
          {status}
        </p>
      ) : null}
      <table className="reports-table" aria-label="날짜·버전별 보고 수">
        <thead>
          <tr>
            <th>날짜</th>
            <th>버전</th>
            <th>종류</th>
            <th>보고</th>
            <th>설치</th>
          </tr>
        </thead>
        <tbody>
          {summary.map((row) => (
            <tr key={`${row.day}-${row.version}-${row.kind}`}>
              <td>{row.day}</td>
              <td>{row.version}</td>
              <td>{row.kind}</td>
              <td>{row.reports}</td>
              <td>{row.installs}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="reports-table" aria-label="받은 보고">
        <thead>
          <tr>
            <th>받은 시각</th>
            <th>설치</th>
            <th>버전</th>
            <th>OS</th>
            <th>오류</th>
            <th>가장 많은 오류</th>
            <th>종료</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <Fragment key={report.id}>
              <tr>
                <td>{new Date(report.received_at).toLocaleString('ko-KR')}</td>
                <td>
                  <code>{report.install_id.slice(0, 8)}</code>
                </td>
                <td>{report.version}</td>
                <td>{report.brief.os}</td>
                <td>{report.brief.errors}</td>
                <td>{report.brief.topError}</td>
                <td>{report.brief.exits}</td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => setOpen(open === report.id ? '' : report.id)}
                  >
                    {open === report.id ? '접기' : '내용'}
                  </button>
                </td>
              </tr>
              {open === report.id ? (
                <tr>
                  <td colSpan={8}>
                    <pre className="reports-payload">{JSON.stringify(report.payload, null, 2)}</pre>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!reports.length && !status ? <p className="empty">받은 보고가 없습니다.</p> : null}
    </section>
  );
}
