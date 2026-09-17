# Project Tasks

## #1 Verify build [agent:test-vps] [status:done]
- Job: job-completed
- Session: ses-completed

## #2 Deploy build [agent:test-vps] [status:running] [needs: #1]
- Job: job-running
- Session: ses-running

## #3 Collect evidence [agent:test-vps] [status:failed]
- Job: job-callback-failed
