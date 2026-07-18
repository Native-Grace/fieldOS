/**
 * Queue.gs
 * Background queue worker and lifecycle manager.
 */

const Queue = {
  
  hasActiveTrigger: function() {
    const triggers = ScriptApp.getProjectTriggers();
    return triggers.some(t => t.getHandlerFunction() === 'queueProcessAll');
  },

  clearStaleTriggers: function() {
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'queueProcessAll') {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  },

  triggerWorker: function() {
    // Wrap in a lock to prevent concurrent webhook calls from generating duplicate triggers
    Utils.withLock("TRIGGER_WORKER_LOCK", 5000, () => {
      if (this.hasActiveTrigger()) return; 
      
      this.clearStaleTriggers();
      ScriptApp.newTrigger('queueProcessAll')
               .timeBased()
               .after(500) 
               .create();
    });
  },

  processNext: function() {
    // Only fetch jobs explicitly marked as "Queued"
    const pendingJobs = JobSheetRepository.find({ processing_status: Config.QUEUE_STATUS.QUEUED });
    if (!pendingJobs || pendingJobs.length === 0) return false;

    const job = pendingJobs[0];
    const jobId = job.job_sheet_id;
    let jobToProcess = null;
    
    // Lock is only used to claim the job safely.
    try {
      Utils.withLock(`CLAIM_JOB_${jobId}`, 5000, () => {
        const safeJob = JobSheetRepository.findById(jobId);
        
        if (safeJob && safeJob.processing_status === Config.QUEUE_STATUS.QUEUED) {
          // Claim the job and record start time
          JobSheetRepository.update(jobId, { 
            processing_status: Config.QUEUE_STATUS.PROCESSING,
            processing_started_at: new Date()
          });
          jobToProcess = safeJob; 
        }
      });
    } catch (lockError) {
      console.warn(`Could not acquire claim lock for Job ${jobId}: ${lockError.message}`);
      return true; // Return true to allow processAllQueued to move to the next item
    }

    // If another worker claimed this job while we waited for the lock, skip it.
    if (!jobToProcess) return true;

    // EXECUTE PIPELINE OUTSIDE OF THE LOCK
    try {
      if (typeof VoiceProcessing !== 'undefined') {
        VoiceProcessing.executePipeline(jobToProcess);
        
        // Ensure completed timestamp is recorded (assuming VoiceProcessing handles the status update)
        JobSheetRepository.update(jobId, {
          processing_completed_at: new Date()
        });
      } else {
        throw new Error("VoiceProcessing module is undefined or missing.");
      }
      
      SyncRepository.create({
        record_id: jobId,
        target_system: "Queue_Worker",
        status: "Success",
        request_payload: "Queue.processNext()",
        response_payload: "Job processed successfully.",
        timestamp: new Date()
      });

    } catch (error) {
      const stack = Utils.getStackTrace(error);
      
      // On failure, apply failure state and flag for review
      JobSheetRepository.update(jobId, {
        processing_status: Config.QUEUE_STATUS.FAILED,
        processing_error: stack,
        approval_status: "Pending Review",
        processing_completed_at: new Date()
      });
      
      SyncRepository.create({
        record_id: jobId,
        target_system: "Queue_Worker",
        status: "Failed",
        request_payload: "Queue.processNext()",
        response_payload: stack,
        timestamp: new Date()
      });
    }
    
    return true; 
  },

  processAllQueued: function() {
    let processedOrSkipped = true;
    let iterationLimit = 10; // Prevent hitting Google's 6-minute execution quota limit
    
    while (processedOrSkipped && iterationLimit > 0) {
      processedOrSkipped = this.processNext();
      iterationLimit--;
    }
    
    // If quota safeguard hit but jobs remain, re-trigger for a fresh execution window
    if (processedOrSkipped && iterationLimit === 0) {
      this.clearStaleTriggers();
      this.triggerWorker();
    }
  }
};

/**
 * Global entry point for the Time-Driven Trigger.
 */
function queueProcessAll() {
  Queue.clearStaleTriggers();
  Queue.processAllQueued();
}

/**
 * MANUAL TEST FUNCTION: Processes the next queued job immediately in the IDE.
 */
function testProcessNextQueuedJob() {
  Logger.log("Starting manual queue test...");
  const processed = Queue.processNext();
  if (processed) {
    Logger.log("A job was processed or skipped. Check tbl_job_sheets and tbl_sync_logs for results.");
  } else {
    Logger.log("No jobs found with processing_status = 'Queued'.");
  }
}

/**
 * MANUAL TEST FUNCTION: Finds an existing job sheet, sets it to 'Queued', and triggers the worker.
 */
function testQueueFirstDraftJobSheet() {
  Logger.log("Looking for a job sheet to enqueue...");
  
  const allJobs = JobSheetRepository.findAll();
  if (!allJobs || allJobs.length === 0) {
    Logger.log("No job sheets exist in tbl_job_sheets. Please create one first.");
    return;
  }
  
  // Find a job that isn't currently Queued, Processing, or Completed
  const targetJob = allJobs.find(job => 
    job.processing_status !== Config.QUEUE_STATUS.QUEUED && 
    job.processing_status !== Config.QUEUE_STATUS.PROCESSING && 
    job.processing_status !== Config.QUEUE_STATUS.COMPLETED
  );
  
  if (!targetJob) {
    Logger.log("No eligible job sheets exist to enqueue. All are currently queued, processing, or completed.");
    return;
  }
  
  Logger.log(`Enqueueing Job Sheet ID: ${targetJob.job_sheet_id}`);
  
  JobSheetRepository.update(targetJob.job_sheet_id, {
    processing_status: Config.QUEUE_STATUS.QUEUED,
    processing_error: ""
  });
  
  Logger.log("Job queued. Spawning background worker...");
  Queue.triggerWorker();
  
  Logger.log("Worker triggered. Check the Executions tab in 1-2 minutes to view the background run.");
}