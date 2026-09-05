import mongoose from 'mongoose';

/**
 * Run work in a transaction, retrying transient failures.
 *
 * Two concurrent acceptances touching the same ride document make MongoDB abort
 * one of them with a WriteConflict (code 112), labelled TransientTransactionError.
 * That is not a business outcome — the losing caller's work never ran, and
 * surfacing it would fail a booking that should simply have been retried, or
 * worse, report "seats unavailable" when seats remained.
 *
 * `session.withTransaction` replays the callback on exactly those labelled
 * errors and commits once it succeeds. Application errors carry no such label,
 * so a genuine SEATS_UNAVAILABLE aborts and propagates on the first attempt.
 *
 * The callback must therefore be safe to run more than once: re-read state
 * inside it rather than closing over values read beforehand.
 */
export const runInTransaction = async (work) => {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      result = await work(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
};
