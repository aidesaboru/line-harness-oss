import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type EventBookingMine } from '../lib/api.js';

function formatJp(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
}

const statusLabel: Record<string, { text: string; cls: string }> = {
  requested: { text: '承認待ち', cls: 'bg-yellow-100 text-yellow-800' },
  confirmed: { text: '確定', cls: 'bg-green-100 text-green-800' },
  rejected: { text: '見送り', cls: 'bg-gray-200 text-gray-700' },
  cancelled: { text: 'キャンセル', cls: 'bg-gray-100 text-gray-600' },
  expired: { text: '期限切れ', cls: 'bg-gray-100 text-gray-500' },
  attended: { text: '参加済', cls: 'bg-blue-100 text-blue-800' },
  no_show: { text: '不参加', cls: 'bg-red-100 text-red-700' },
};

const EVENT_BOOKINGS_LOAD_ERROR = 'イベント予約の読み込みに失敗しました。時間をおいて再度お試しください。';
const EVENT_BOOKING_CANCEL_ERROR = 'イベント予約のキャンセルに失敗しました。時間をおいて再度お試しください。';

function canCancel(b: EventBookingMine): boolean {
  if (b.status !== 'requested' && b.status !== 'confirmed') return false;
  if (b.cancel_deadline_hours_before == null) return false;
  const deadlineMs = new Date(b.slot_starts_at).getTime() - b.cancel_deadline_hours_before * 3600_000;
  return deadlineMs > Date.now();
}

function getCancelErrorMessage(err: unknown): string {
  const e = err as { body?: { error?: string } };
  switch (e.body?.error) {
    case 'cancel_deadline_passed': return 'キャンセル期限を過ぎています。';
    case 'cancel_not_allowed': return 'このイベントは LIFF からのキャンセルに対応していません。LINE で運営にご連絡ください。';
    case 'invalid_state': return 'この予約は既にキャンセル済 / 確定外のためキャンセルできません。';
    default: return EVENT_BOOKING_CANCEL_ERROR;
  }
}

export default function EventBookings() {
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [items, setItems] = useState<EventBookingMine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState<EventBookingMine | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.myEventBookings(tab);
      setItems(res.items);
    } catch (e) {
      setError(EVENT_BOOKINGS_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function cancel(b: EventBookingMine) {
    setBusy(true);
    setError(null);
    try {
      await api.cancelMyEventBooking(b.id);
      await refresh();
    } catch (err) {
      setError(getCancelErrorMessage(err));
    } finally {
      setBusy(false);
      setPendingCancel(null);
    }
  }

  return (
    <div className="pb-16">
      <div className="border-b sticky top-0 bg-white z-10">
        <div className="flex">
          {(['upcoming', 'past'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm ${tab === t ? 'border-b-2 border-blue-600 text-blue-600 font-medium' : 'text-gray-600'}`}
            >
              {t === 'upcoming' ? 'これから' : '過去'}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3 space-y-3">
        {error && <div className="bg-red-50 text-red-700 p-2 rounded text-sm">{error}</div>}
        {loading ? (
          <div className="text-center text-gray-500 py-8">読み込み中...</div>
        ) : items.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            {tab === 'upcoming' ? 'これからの予約はありません' : '過去の予約はありません'}
          </div>
        ) : (
          items.map((b) => {
            const s = statusLabel[b.status] ?? { text: b.status, cls: 'bg-gray-100' };
            return (
              <div key={b.id} className="border rounded overflow-hidden">
                <div className="flex">
                  {b.event_image_url ? (
                    <img src={b.event_image_url} alt="" className="w-20 h-20 object-cover bg-gray-100" />
                  ) : (
                    <div className="w-20 h-20 bg-gradient-to-br from-blue-100 to-blue-200" />
                  )}
                  <div className="flex-1 p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-semibold text-sm line-clamp-2">{b.event_name}</div>
                      <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${s.cls}`}>{s.text}</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-1">{formatJp(b.slot_starts_at)}</div>
                    {b.venue_name && <div className="text-xs text-gray-600">📍 {b.venue_name}</div>}
                  </div>
                </div>
                {canCancel(b) && (
                  <div className="border-t p-2 text-right">
                    <button
                      onClick={() => setPendingCancel(b)}
                      disabled={busy}
                      className="text-sm text-red-600 hover:underline disabled:opacity-50"
                    >
                      キャンセルする
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="text-center mt-4">
        <Link to="/booking" className="text-xs text-gray-500 underline">サロン予約はこちら</Link>
      </div>
      {pendingCancel && (
        <div className="fixed inset-0 z-20 flex items-end bg-black/40 px-3 py-4 sm:items-center">
          <div className="mx-auto w-full max-w-md rounded-lg bg-white p-4 shadow-lg">
            <h2 className="text-base font-bold text-gray-900">予約をキャンセルしますか？</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              「{pendingCancel.event_name}」の予約をキャンセルします。この操作は運営に通知されます。
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPendingCancel(null)}
                disabled={busy}
                className="rounded border border-gray-300 px-3 py-3 text-sm font-semibold text-gray-700 disabled:opacity-50"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => void cancel(pendingCancel)}
                disabled={busy}
                className="rounded bg-red-600 px-3 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'キャンセル中...' : 'キャンセルする'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
