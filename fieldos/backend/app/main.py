from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger, log_extra
from app.services.completion_math import format_completion_validation_loc, preview_validation_input

settings = get_settings()
configure_logging(settings.log_level)
logger = get_logger("fieldos")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.ensure_data_dirs()
    log_extra(
        logger,
        20,
        "FieldOS API starting",
        env=settings.fieldos_env,
        data_mode=settings.data_mode,
        apps_script_configured=bool(settings.apps_script_webapp_url),
    )
    yield


app = FastAPI(title="Native Grace FieldOS", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


def _is_completion_mutation_path(path: str) -> bool:
    return "/completion" in path and (
        path.rstrip("/").endswith("/completion")
        or path.rstrip("/").endswith("/generate")
        or path.rstrip("/").endswith("/finalise")
        or path.rstrip("/").endswith("/reopen")
    )


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = list(exc.errors() or [])
    path = str(request.url.path)
    messages: list[str] = []
    for err in errors:
        loc = tuple(err.get("loc") or ())
        location = ".".join(str(p) for p in loc if p != "body")
        input_value = err.get("input")
        input_type = type(input_value).__name__ if input_value is not None else "NoneType"
        if _is_completion_mutation_path(path):
            log_extra(
                logger,
                30,
                "Completion request validation failed",
                endpoint=path,
                validation_location=location or "body",
                input_type=input_type,
                input_preview=preview_validation_input(input_value),
            )
            messages.append(format_completion_validation_loc(loc))
        else:
            msg = str(err.get("msg") or "Invalid request")
            messages.append(msg if not location else f"{location}: {msg}")

    detail = "; ".join(dict.fromkeys(messages)) if messages else "Invalid request"
    # Prefer a single friendly string for completion UIs (not raw Pydantic wording).
    if _is_completion_mutation_path(path):
        return JSONResponse(status_code=422, content={"detail": detail})
    return JSONResponse(status_code=422, content={"detail": errors or detail})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log_extra(logger, 40, "Unhandled error", path=str(request.url.path), error=str(exc))
    return JSONResponse(
        status_code=500,
        content={"status": "Error", "message": "Internal server error", "detail": str(exc)},
    )
