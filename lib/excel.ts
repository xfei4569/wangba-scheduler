'use client';

/**
 * Excel 导出（xlsx-js-style，浏览器里生成并下载，不经过服务端）。
 *
 * 一次导出两个 sheet（店长截图 + 需求⑤ 的原始要求）：
 *   Sheet「按班次」：一天一行，列是班次，格子里是「谁上这个班（几个人）」，末列是当日需求人次；
 *   Sheet「按员工」：一人一行，列是日期（星期+月日），格子写 白班/中班/夜班/休/请假/待排，
 *                   整行按人着色，右侧是出勤/休息/晚班小计，底部再列一遍每人合计。
 * 小计一律由格子现算（数格子），保证「小计与格子一致」，不会出现两处各算一套对不上的情况。
 */
import { weekdayCn } from './date';

/** 班次在导出表里的写法（截图：白班/中班/夜班） */
export const SHIFT_CELL_CN: Record<string, string> = { early: '白班', middle: '中班', night: '夜班' };
export const REST_CELL = '休';
export const LEAVE_CELL = '请假';
export const PENDING_CELL = '待排';

export interface PeopleMatrixPerson {
  /** 显示名（可带「（店长）（新人）」） */
  name: string;
  /** 与 dates 一一对应：白班/中班/夜班/休/请假/待排 */
  cells: string[];
}

/** 「按班次」表里某天某班的一格 */
export interface ShiftGridCell {
  /** 该班已排的人名（显示名） */
  people: string[];
  /** 该班需求人数 */
  demand: number;
}

export interface PeopleMatrixPayload {
  title: string;
  /** 'YYYY-MM-DD'，导出时自动生成「星期 + 月日」表头 */
  dates: string[];
  people: PeopleMatrixPerson[];
  /** 「按班次」表的班次列头（如「早班 09:00」）。不传就只导出「按员工」一个 sheet */
  shiftHeaders?: string[];
  /** 与 dates × shiftHeaders 一一对应；缺省按空班处理 */
  shiftCells?: ShiftGridCell[][];
  note?: string;
  fileName: string;
}

/** 一人一色（浅底黑字），人数超过色板时循环 */
const PERSON_FILLS = ['BDD7EE', 'C6E0B4', 'F8CBAD', 'D9C2E8', 'FFE699', 'D0CECE', 'FBE5D6', 'DEEAF6', 'E2EFDA', 'F4B183'];

const thin = { style: 'thin', color: { rgb: 'FFBFBFBF' } };
const border = { top: thin, bottom: thin, left: thin, right: thin };
const center = { horizontal: 'center', vertical: 'center' } as const;
const fill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb: 'FF' + rgb } });

const WORK_CELLS = new Set(Object.values(SHIFT_CELL_CN));
/** 小计全部由格子现算：出勤 / 休息 / 晚班（请假与待排不计入这四项） */
function tally(cells: string[]) {
  return {
    work: cells.filter((c) => WORK_CELLS.has(c)).length,
    rest: cells.filter((c) => c === REST_CELL).length,
    night: cells.filter((c) => c === SHIFT_CELL_CN.night).length,
    leave: cells.filter((c) => c === LEAVE_CELL).length,
  };
}

const md = (date: string) => Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';

/**
 * 「按班次」表里一格写什么（B6 与月表 / 周视图同一显示口径）：
 *   0 人（含「排过后又删空」）= 待排（PENDING_CELL，不再写「缺 N 人」）；
 *   0 < 人数 < 需求 = 缺 N 人；人数 > 需求 = 多 N 人；正好 = 名单（N 人）。
 */
export function shiftCellText(cell: ShiftGridCell): string {
  const assigned = cell.people.length;
  if (!assigned && !cell.demand) return '—';
  if (!assigned) return PENDING_CELL + '（需 ' + cell.demand + '）';
  if (assigned < cell.demand) return cell.people.join('、') + ' （缺 ' + (cell.demand - assigned) + ' 人／需 ' + cell.demand + '）';
  if (assigned > cell.demand) return cell.people.join('、') + '（多 ' + (assigned - cell.demand) + ' 人／需 ' + cell.demand + '）';
  return cell.people.join('、') + '（' + assigned + ' 人）';
}

export async function exportPeopleMatrixExcel(payload: PeopleMatrixPayload): Promise<void> {
  const mod = (await import('xlsx-js-style')) as unknown as { utils?: unknown; default?: typeof import('xlsx-js-style') };
  const XLSX = (mod.utils ? mod : mod.default) as typeof import('xlsx-js-style');
  const n = payload.dates.length;
  const book = XLSX.utils.book_new();

  /* ---------------- Sheet 1：按班次（一天一行） ---------------- */
  if (payload.shiftHeaders?.length && payload.shiftCells) {
    const shifts = payload.shiftHeaders;
    const grid: (string | number)[][] = [];
    grid.push([payload.title + '（按班次）']);
    grid.push([payload.dates[0] + ' 至 ' + payload.dates[n - 1] + ' · 共 ' + n + ' 天']);
    grid.push([]);
    grid.push(['日期', '星期', ...shifts, '本日需求人次']);
    payload.dates.forEach((date, i) => {
      const row = payload.shiftCells?.[i] || [];
      let demandTotal = 0;
      const cells = shifts.map((_, j) => {
        const cell = row[j] || { people: [], demand: 0 };
        demandTotal += cell.demand;
        return shiftCellText(cell);
      });
      grid.push([md(date), weekdayCn(date), ...cells, demandTotal]);
    });
    if (payload.note) { grid.push([]); grid.push([payload.note]); }

    const sheet1 = XLSX.utils.aoa_to_sheet(grid);
    for (let c = 0; c <= 2 + shifts.length; c++) {
      const head = sheet1[XLSX.utils.encode_cell({ r: 3, c })];
      if (head) head.s = { fill: fill('D9D9D9'), border, alignment: center, font: { bold: true } };
    }
    sheet1['!cols'] = [{ wch: 12 }, { wch: 8 }, ...shifts.map(() => ({ wch: 28 })), { wch: 14 }];
    sheet1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 + shifts.length } }];
    XLSX.utils.book_append_sheet(book, sheet1, '按班次');
  }

  /* ---------------- Sheet 2：按员工（一人一行） ---------------- */
  const rows: (string | number)[][] = [];
  rows.push([payload.title + '（按员工）', ...payload.dates.map(() => '')]);
  // 表头：员工 | 周一 10-05 | … | 出勤 | 休息 | 晚班 | 请假
  rows.push(['员工', ...payload.dates.map((d) => weekdayCn(d) + ' ' + d.slice(5)), '出勤', '休息', '晚班', '请假']);
  const tallies = payload.people.map((p) => tally(payload.dates.map((_, i) => p.cells[i] ?? '')));
  payload.people.forEach((p, i) => {
    const t = tallies[i];
    rows.push([p.name, ...payload.dates.map((_, j) => p.cells[j] ?? ''), t.work, t.rest, t.night, t.leave]);
  });
  const noteRow = payload.note ? rows.length + 2 : -1;
  rows.push([]);
  rows.push(['每人合计']);
  payload.people.forEach((p, i) => {
    const t = tallies[i];
    rows.push([p.name + '：出勤 ' + t.work + ' 天 / 休 ' + t.rest + ' 天 / 晚班 ' + t.night + ' 次']);
  });
  if (payload.note) { rows.push([]); rows.push([payload.note]); }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  // 标题行
  for (let c = 0; c <= n + 4; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = { font: { bold: true, size: 14 }, alignment: { horizontal: 'left', vertical: 'center' } };
  }
  // 表头行
  for (let c = 0; c <= n + 4; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 1, c })];
    if (cell) cell.s = { fill: fill('D9D9D9'), border, alignment: center, font: { bold: true } };
  }
  // 一人一行：格子整行按人着色，姓名加粗留白（与截图一致）
  payload.people.forEach((p, i) => {
    const r = 2 + i;
    const nameCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    if (nameCell) nameCell.s = { border, alignment: { horizontal: 'left', vertical: 'center' }, font: { bold: true } };
    for (let c = 1; c <= n; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      // 空缺（未排的天）用醒目黄色标出，店长可以把手工排的直接填进去
      const gap = cell.v === PENDING_CELL;
      cell.s = gap
        ? { fill: fill('FFF2CC'), border, alignment: center, font: { bold: true, color: { rgb: 'FFB26B00' } } }
        : { fill: fill(PERSON_FILLS[i % PERSON_FILLS.length]), border, alignment: center };
    }
    // 右侧小计列
    for (let c = n + 1; c <= n + 4; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.s = { border, alignment: center, font: { bold: true } };
    }
  });
  // 底部「每人合计」
  const totalHead = rows.findIndex((row) => row[0] === '每人合计');
  for (let r = totalHead; r < rows.length; r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    if (cell && r > totalHead) cell.s = { font: { italic: true, color: { rgb: 'FF595959' } }, alignment: { horizontal: 'left', vertical: 'center' } };
    else if (cell) cell.s = { font: { bold: true }, alignment: { horizontal: 'left', vertical: 'center' } };
  }
  if (noteRow >= 0) {
    const cell = sheet[XLSX.utils.encode_cell({ r: noteRow, c: 0 })];
    if (cell) cell.s = { font: { italic: true, color: { rgb: 'FF808080' } }, alignment: { horizontal: 'left', vertical: 'center' } };
  }

  sheet['!cols'] = [{ wch: 14 }, ...payload.dates.map(() => ({ wch: 10 })), { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: n + 4 } }];
  XLSX.utils.book_append_sheet(book, sheet, '按员工');

  XLSX.writeFile(book, payload.fileName, { compression: true });
}
