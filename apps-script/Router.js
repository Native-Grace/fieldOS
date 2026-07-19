/**
 * Router.js
 * Master HTTP Gateway and Request Router
 */

function doPost(e) {
  let rawPayload = "";
  let actionContext = "unknown";
  let jobIdContext = null;

  try {
    rawPayload = e?.postData?.contents;
    if (!rawPayload) throw new Error("Missing inbound postData payload.");

    const payload = JSON.parse(rawPayload);
    actionContext = payload.action || "unknown";
    jobIdContext = payload.job_sheet_id || null;

    // Strict Security Verification (constant-time compare via FieldOSGateway.js)
    const providedSecret = payload.webhook_secret;
    fieldosVerifyWebhookSecret_(providedSecret);

    // Process Routing
    const result = routeRequest(payload);

    if (result.data !== undefined) {
      return fieldosJsonResponse(
        "Success",
        result.action,
        result.message,
        result.job_sheet_id,
        result.data
      );
    }

    return Utils.createJsonResponse("Success", result.action, result.message, result.job_sheet_id);

  } catch (err) {
    // Isolated logging block ensures we don't drop the HTTP response if the DB lock times out
    try {
      SyncRepository.create({
        record_id: jobIdContext || "GATEWAY",
        target_system: "HTTP_ROUTER",
        status: "Failed",
        request_payload: redactWebhookSecretFromPayload_(rawPayload),
        response_payload: Utils.getStackTrace(err),
        timestamp: new Date()
      });
    } catch (loggingErr) {
      console.error("CRITICAL: Failed to write to Sync log.", loggingErr);
    }

    return Utils.createJsonResponse("Error", actionContext, err.toString(), jobIdContext);
  }
}

/**
 * Redact webhook_secret from raw JSON before writing to SyncRepository / logs.
 * Never logs or returns the secret value.
 */
function redactWebhookSecretFromPayload_(rawPayload) {
  if (!rawPayload) return "EMPTY";
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (Object.prototype.hasOwnProperty.call(parsed, "webhook_secret")) {
        parsed.webhook_secret = "REDACTED";
      }
      return JSON.stringify(parsed);
    }
  } catch (parseErr) {
    // Non-JSON body: avoid storing opaque blobs that may contain secrets
    return "[UNPARSEABLE_PAYLOAD_REDACTED]";
  }
  return "[PAYLOAD_REDACTED]";
}

function routeRequest(payload) {
  const { action, job_sheet_id, force_reprocess } = payload;

  if (!action) throw new Error("Missing required attribute: 'action'.");

  switch (action) {
    case "process_voice_dictation":
      if (!job_sheet_id) throw new Error("Action requires 'job_sheet_id'.");

      const job = JobSheetRepository.findById(job_sheet_id);
      if (!job) throw new Error("Job sheet not found: " + job_sheet_id);

      if (job.processing_status === Config.QUEUE_STATUS.COMPLETED && force_reprocess !== true) {
        return {
          action: action,
          message: "Job already completed. Skipping.",
          job_sheet_id: job_sheet_id
        };
      }

      JobSheetRepository.update(job_sheet_id, {
        processing_status: Config.QUEUE_STATUS.QUEUED,
        processing_error: ""
      });

      const safePayload = { ...payload, webhook_secret: "REDACTED" };

      SyncRepository.create({
        record_id: job_sheet_id,
        target_system: "AppSheet_Webhook",
        status: "Success",
        request_payload: JSON.stringify(safePayload),
        response_payload: "Queued for background worker.",
        timestamp: new Date()
      });

      Queue.triggerWorker();
      return { action: action, message: "Job successfully queued.", job_sheet_id: job_sheet_id };

    case "execute_worker":
      Queue.triggerWorker();
      return { action: action, message: "Background queue worker triggered manually.", job_sheet_id: null };

    case "list_jobs_for_staff":
    case "get_job_detail":
    case "register_recording": {
      const fieldosResult = fieldosRouteRequest(payload);
      if (!fieldosResult) {
        throw new Error(`Routing Failure: Action '${action}' is unsupported.`);
      }
      return fieldosResult;
    }

    default:
      throw new Error(`Routing Failure: Action '${action}' is unsupported.`);
  }
}

/**
 * MANUAL TEST FUNCTION: Simulates an inbound webhook from AppSheet.
 */
function testDoPost() {
  // CRITICAL: Replace 'TEST-JOB-ID-123' with an actual job_sheet_id from tbl_job_sheets before running.
  const mockEvent = {
    postData: {
      contents: JSON.stringify({
        action: "process_voice_dictation",
        job_sheet_id: "TEST-JOB-ID-123",
        user_identity: "test@nativegrace.com",
        force_reprocess: false,
        webhook_secret: Config.getWebhookSecret()
      })
    }
  };

  const response = doPost(mockEvent);
  Logger.log("doPost Response: " + response.getContent());
}

/**
 * Native AppSheet Automation Entry Point
 * Bypasses Workspace HTTP Webhook restrictions by running natively within the domain boundary.
 */
function appsheetTriggerRoute(job_sheet_id, user_identity, force_reprocess) {
  try {
    if (!job_sheet_id) throw new Error("Missing required argument: job_sheet_id");

    // Construct a mock payload identical to what routeRequest expects
    const payload = {
      action: "process_voice_dictation",
      job_sheet_id: job_sheet_id,
      user_identity: user_identity || "unknown_appsheet_user",
      force_reprocess: force_reprocess === true || force_reprocess === "true"
    };

    // Route directly into our existing queue logic
    const result = routeRequest(payload);

    console.log(`Internal Routing Success: ${result.message} for Job ${job_sheet_id}`);
    return `Success: ${result.message}`;

  } catch (err) {
    console.error(`Internal Routing Failure for Job ${job_sheet_id}: ${err.toString()}`);

    // Log the error natively to sync logs
    try {
      SyncRepository.create({
        record_id: job_sheet_id || "INTERNAL_BYPASS",
        target_system: "APPS_SCRIPT_TASK",
        status: "Failed",
        request_payload: JSON.stringify({ job_sheet_id, user_identity, force_reprocess }),
        response_payload: Utils.getStackTrace(err),
        timestamp: new Date()
      });
    } catch (loggingErr) {
      console.error("Failed to write internal error to Sync log.", loggingErr);
    }

    throw new Error(err.toString()); // Propagate error back to AppSheet sync logs
  }
}

function doGet(e) {
  const mode = String(e.parameter.mode || '').trim();

  if (mode === 'recorder') {
    return serveRecorder_(e);
  }

  return HtmlService.createHtmlOutput('Native Grace FieldOS');
}
