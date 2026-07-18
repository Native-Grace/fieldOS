from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger, log_extra

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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log_extra(logger, 40, "Unhandled error", path=str(request.url.path), error=str(exc))
    return JSONResponse(
        status_code=500,
        content={"status": "Error", "message": "Internal server error", "detail": str(exc)},
    )
