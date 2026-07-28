const express = require('express');
const request = require('supertest');
const serviceContainer = require('../../src/config/serviceContainer');

describe('Admin Scheduler Controls (Issue #1325)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Bypass RBAC middleware for unit test environment
    app.use((req, res, next) => {
      req.user = { role: 'admin' };
      req.apiKey = { role: 'admin' };
      next();
    });
    app.use('/admin/scheduler', require('../../src/routes/admin/scheduler'));
  });

  it('should pause and resume the real production scheduler instance resolved via serviceContainer', async () => {
    const realScheduler = serviceContainer.getRecurringDonationScheduler();
    
    // Initial state: not paused
    expect(realScheduler.isPaused()).toBe(false);

    // Call pause endpoint
    const pauseRes = await request(app).post('/admin/scheduler/pause');
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.success).toBe(true);
    expect(pauseRes.body.data.paused).toBe(true);

    // Verify real instance in serviceContainer is now paused
    expect(realScheduler.isPaused()).toBe(true);

    // Call resume endpoint
    const resumeRes = await request(app).post('/admin/scheduler/resume');
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.success).toBe(true);
    expect(resumeRes.body.data.resumed).toBe(true);

    // Verify real instance in serviceContainer is unpaused
    expect(realScheduler.isPaused()).toBe(false);
  });
});
