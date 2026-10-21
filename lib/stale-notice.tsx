'use client';

import { Modal } from 'antd';

/** 请假、避班改动后，告诉店长哪些草稿周还是旧班表。 */
export function noticeStaleWeeks(weeks: string[] | undefined, verb: string): void {
  if (!weeks?.length) return;
  Modal.warning({
    title: '已有班表还是旧的',
    content: weeks.join('、') + ' 已经生成过草稿。' + verb + '不会自动改班表，请到周排班里重算未来班次，再检查锁定。',
  });
}
