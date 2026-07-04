import boto3

from worker.config import Settings


def create_s3(settings: Settings):
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
    )


def audio_key(user_id: str, job_id: str) -> str:
    # Keys are namespaced by owner; the gateway's ownership check is the
    # only read path, so object names never leak across users.
    return f"audio/{user_id}/{job_id}.wav"


def upload_wav(s3, bucket: str, key: str, data: bytes) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType="audio/wav")
