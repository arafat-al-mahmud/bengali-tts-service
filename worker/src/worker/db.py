from dataclasses import dataclass

import psycopg


@dataclass(frozen=True)
class JobRow:
    id: str
    user_id: str
    input_text: str
    status: str


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, autocommit=True)


def fetch_job(conn: psycopg.Connection, job_id: str) -> JobRow | None:
    row = conn.execute(
        "SELECT id, user_id, input_text, status FROM jobs WHERE id = %s",
        (job_id,),
    ).fetchone()
    if row is None:
        return None
    return JobRow(id=row[0], user_id=row[1], input_text=row[2], status=row[3])


def mark_active(conn: psycopg.Connection, job_id: str) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'ACTIVE', started_at = now() WHERE id = %s",
        (job_id,),
    )


def mark_queued(conn: psycopg.Connection, job_id: str) -> None:
    """Reset to QUEUED while BullMQ waits out a retry backoff."""
    conn.execute("UPDATE jobs SET status = 'QUEUED' WHERE id = %s", (job_id,))


def mark_completed(conn: psycopg.Connection, job_id: str, audio_key: str) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'COMPLETED', audio_key = %s, completed_at = now() WHERE id = %s",
        (audio_key, job_id),
    )


def mark_failed(conn: psycopg.Connection, job_id: str, code: str, message: str) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'FAILED', error_code = %s, error_message = %s, "
        "completed_at = now() WHERE id = %s",
        (code, message, job_id),
    )
