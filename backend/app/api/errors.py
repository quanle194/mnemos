"""Structured error contract: {"error": {code, message, details, request_id}}."""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.observability.logging import request_id_var
from app.tenancy import AuthError, Conflict, NotFound, PermissionDenied, ValidationFailed

log = structlog.get_logger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None,
                 headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details = details or {}
        self.headers = headers


def error_response(status: int, code: str, message: str, details: dict[str, Any] | None = None,
                   headers: dict[str, str] | None = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "details": details or {},
                      "request_id": request_id_var.get()}}
    return JSONResponse(body, status_code=status, headers=headers)


def _jsonable(d: dict[str, Any]) -> dict[str, Any]:
    return {k: (v if isinstance(v, str | int | float | bool | type(None) | list | dict) else str(v))
            for k, v in d.items()}


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(AuthError)
    async def _auth(_: Request, exc: AuthError) -> JSONResponse:
        return error_response(401, "unauthorized", str(exc), headers={"WWW-Authenticate": "Bearer"})

    @app.exception_handler(PermissionDenied)
    async def _perm(_: Request, exc: PermissionDenied) -> JSONResponse:
        return error_response(403, "forbidden", str(exc))

    @app.exception_handler(NotFound)
    async def _nf(_: Request, exc: NotFound) -> JSONResponse:
        return error_response(404, "not_found", str(exc))

    @app.exception_handler(Conflict)
    async def _conflict(_: Request, exc: Conflict) -> JSONResponse:
        headers = {}
        if "current_version" in exc.details:
            headers["ETag"] = f'"{exc.details["current_version"]}"'
        return error_response(409, "conflict", str(exc), _jsonable(exc.details), headers)

    @app.exception_handler(ValidationFailed)
    async def _vf(_: Request, exc: ValidationFailed) -> JSONResponse:
        return error_response(422, "validation_error", str(exc))

    @app.exception_handler(RequestValidationError)
    async def _rv(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]
        return error_response(422, "validation_error", "request validation failed", {"errors": errors})

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed", 413: "payload_too_large"}.get(exc.status_code, "error")
        return error_response(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_error", error=str(exc))
        return error_response(500, "internal_error", "internal server error")
