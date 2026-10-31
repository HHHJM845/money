import { ChevronRight, CircleAlert } from 'lucide-react';
import { money } from './finance';
import { kindNames, pendingReasons, timestampLabel, type Bill } from './bookkeeping-api';

export default function PendingList({ bills, open }: { bills: Bill[]; open: (bill: Bill) => void }) {
  if (!bills.length) return <div className="empty" role="status"><CircleAlert size={25} /><h2>暂无待确认账单</h2><p>需要核对的交易会集中显示在这里。</p></div>;
  return <section className="pending-list" aria-label="待确认账单">
    <p className="fine">待确认记录不计入统计，也不改变账面余额。以下显示所有月份。</p>
    {bills.map(bill => <button className="pending-row" key={bill.billId} onClick={() => open(bill)}>
      <CircleAlert size={19} /><span className="transaction-description"><strong>{bill.content.merchant || bill.content.note || kindNames[bill.content.kind]}</strong>
        <small>{pendingReasons(bill).join(' · ')}</small><time>{timestampLabel(bill.content.occurredAt)}</time>
      </span><span className="row-amount">{bill.content.amountCents == null ? '待核对' : `¥${money(bill.content.amountCents)}`}</span><ChevronRight size={16} />
    </button>)}
  </section>;
}
