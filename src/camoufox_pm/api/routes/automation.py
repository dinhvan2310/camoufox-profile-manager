"""Short-lived leases for external Playwright clients.

An automation client owns the Camoufox process, while this service keeps the
profile lock and produces the exact launch options for the pinned profile.
"""

from __future__ import annotations

import asyncio
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from camoufox_pm.api.dependencies import get_profile_manager
from camoufox_pm.core import fingerprint_store, proxy_check
from camoufox_pm.core.models import UsageStats

router = APIRouter()


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


class AcquireRequest(BaseModel):
    client_instance_id: str = Field(min_length=1, max_length=200)
    idempotency_key: str = Field(min_length=1, max_length=200)
    headless: bool = False
    window_size: str | None = None
    ttl_seconds: int = Field(default=60, ge=15, le=300)


class StartedRequest(BaseModel):
    lease_token: str = Field(min_length=1)
    process_id: int | None = None
    ttl_seconds: int = Field(default=60, ge=15, le=300)


class HeartbeatRequest(BaseModel):
    lease_token: str = Field(min_length=1)
    ttl_seconds: int = Field(default=60, ge=15, le=300)


class ReleaseRequest(BaseModel):
    lease_token: str = Field(min_length=1)
    outcome: str | None = Field(default=None, max_length=100)


class Lease:
    def __init__(
        self,
        *,
        lease_id: str,
        token: str,
        profile_id: str,
        client_instance_id: str,
        idempotency_key: str,
        expires_at: datetime,
        launch_options: dict[str, Any],
    ) -> None:
        self.lease_id = lease_id
        self.token = token
        self.profile_id = profile_id
        self.client_instance_id = client_instance_id
        self.idempotency_key = idempotency_key
        self.expires_at = expires_at
        self.launch_options = launch_options
        self.state = "acquired"
        self.process_id: int | None = None


_leases: dict[str, Lease] = {}
_lock = asyncio.Lock()


def _expires_in(seconds: int) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _payload(lease: Lease) -> dict[str, Any]:
    return {
        "lease_id": lease.lease_id,
        "lease_token": lease.token,
        "profile_id": lease.profile_id,
        "state": lease.state,
        "expires_at": lease.expires_at.isoformat(),
        "descriptor_version": 1,
        "runtime": {
            "camoufox_version": _package_version("camoufox"),
            "playwright_version": _package_version("playwright"),
        },
        "launch_options": lease.launch_options,
    }


def _prune_expired() -> None:
    now = datetime.now(timezone.utc)
    for lease_id, lease in list(_leases.items()):
        if lease.expires_at <= now:
            del _leases[lease_id]


def _require_lease(lease_id: str, token: str) -> Lease:
    lease = _leases.get(lease_id)
    if lease is None or not secrets.compare_digest(lease.token, token):
        raise HTTPException(status_code=404, detail="Automation lease not found")
    return lease


async def _build_launch_options(
    profile_id: str, request: AcquireRequest
) -> dict[str, Any]:
    manager = get_profile_manager()
    if manager.browser_sessions.is_running(profile_id):
        raise HTTPException(status_code=409, detail="Profile browser is already running")
    profile = await manager.get_profile(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Profile {profile_id} not found")

    options = profile.to_camoufox_launch_options()
    options["headless"] = request.headless
    if request.window_size:
        try:
            width, height = (int(part) for part in request.window_size.lower().split("x"))
            options["window"] = (width, height)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="window_size must be WIDTHxHEIGHT") from exc

    pinned = profile.fingerprint
    if not pinned:
        pinned = fingerprint_store.resolve(options)
        if pinned:
            profile.fingerprint = pinned
    if pinned:
        options["config"] = {**pinned, **options.get("config", {})}

    profile.last_used = datetime.now()
    profile.updated_at = datetime.now()
    await manager.storage.update_profile(profile)
    await manager.storage.log_usage(
        UsageStats(profile_id=profile_id, action="automation_lease", details={"headless": request.headless})
    )
    await proxy_check.fill_what_geoip_would_have(profile.proxy, options)

    # The manager process and its clients usually have different working
    # directories, so never expose a relative profile data directory.
    data_dir = Path(manager.data_dir).resolve()
    storage_path = Path(str(options.get("user_data_dir") or ""))
    if not storage_path.is_absolute():
        options["user_data_dir"] = str((data_dir.parent / storage_path).resolve())
    return options


@router.post("/profiles/{profile_id}/automation-sessions", summary="Acquire an automation lease")
async def acquire(profile_id: str, request: AcquireRequest):
    async with _lock:
        _prune_expired()
        for lease in _leases.values():
            if lease.profile_id != profile_id:
                continue
            if (
                lease.client_instance_id == request.client_instance_id
                and lease.idempotency_key == request.idempotency_key
            ):
                return _payload(lease)
            raise HTTPException(status_code=409, detail="Profile already has an automation lease")
        options = await _build_launch_options(profile_id, request)
        lease = Lease(
            lease_id=uuid.uuid4().hex,
            token=secrets.token_urlsafe(32),
            profile_id=profile_id,
            client_instance_id=request.client_instance_id,
            idempotency_key=request.idempotency_key,
            expires_at=_expires_in(request.ttl_seconds),
            launch_options=options,
        )
        _leases[lease.lease_id] = lease
        return _payload(lease)


@router.post("/automation-sessions/{lease_id}/started", summary="Mark an automation lease started")
async def started(lease_id: str, request: StartedRequest):
    async with _lock:
        _prune_expired()
        lease = _require_lease(lease_id, request.lease_token)
        lease.state = "running"
        lease.process_id = request.process_id
        lease.expires_at = _expires_in(request.ttl_seconds)
        return _payload(lease)


@router.post("/automation-sessions/{lease_id}/heartbeat", summary="Renew an automation lease")
async def heartbeat(lease_id: str, request: HeartbeatRequest):
    async with _lock:
        _prune_expired()
        lease = _require_lease(lease_id, request.lease_token)
        lease.expires_at = _expires_in(request.ttl_seconds)
        return _payload(lease)


@router.delete("/automation-sessions/{lease_id}", summary="Release an automation lease")
async def release(lease_id: str, request: ReleaseRequest):
    async with _lock:
        _prune_expired()
        lease = _require_lease(lease_id, request.lease_token)
        del _leases[lease.lease_id]
        return {"released": True, "profile_id": lease.profile_id, "outcome": request.outcome}
