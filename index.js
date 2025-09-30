const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

// Email configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Email recipient list
const emailList = process.env.EMAIL_RECIPIENTS.split(',').map(email => email.trim());

// Dify API configuration - Self-hosted
const difyConfig = {
  apiKey: process.env.DIFY_API_KEY,
  apiEndpoint: process.env.DIFY_API_ENDPOINT // Your VM endpoint
};

// Function to trigger Dify workflow
async function triggerDifyWorkflow() {
  try {
    console.log('Triggering Dify workflow...');
    
    // Add your workflow inputs here
    const inputs = {
      // Add any inputs your workflow needs
      date: new Date().toLocaleDateString('tr-TR'),
      timestamp: new Date().toISOString(),
      report_type: 'daily',
      // Add more inputs as needed based on your workflow
    };
    
    const response = await axios.post(
      `${difyConfig.apiEndpoint}/workflows/run`,
      {
        inputs: inputs,
        response_mode: process.env.DIFY_RESPONSE_MODE || 'blocking',
        user: process.env.DIFY_USER_ID || 'daily-report-system'
      },
      {
        headers: {
          'Authorization': `Bearer ${difyConfig.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Workflow response received:', response.data.workflow_run_id || 'completed');
    
    // Handle blocking mode response
    if (response.data.data && response.data.data.status === 'succeeded') {
      return {
        workflow_run_id: response.data.workflow_run_id,
        outputs: response.data.data.outputs,
        status: 'succeeded'
      };
    }
    
    // Handle streaming mode or pending response
    return {
      workflow_run_id: response.data.workflow_run_id,
      task_id: response.data.task_id
    };
  } catch (error) {
    console.error('Error triggering Dify workflow:', error.response?.data || error.message);
    throw error;
  }
}

// Function to wait for workflow completion (for streaming mode)
async function waitForWorkflowCompletion(workflowRunId, maxAttempts = 30, delayMs = 10000) {
  if (!workflowRunId) return null;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await axios.get(
        `${difyConfig.apiEndpoint}/workflows/run/${workflowRunId}`,
        {
          headers: {
            'Authorization': `Bearer ${difyConfig.apiKey}`
          }
        }
      );
      
      const status = response.data.status;
      console.log(`Checking workflow status: ${status} (attempt ${i + 1}/${maxAttempts})`);
      
      if (status === 'succeeded') {
        return {
          outputs: response.data.outputs,
          status: 'succeeded',
          elapsed_time: response.data.elapsed_time,
          total_tokens: response.data.total_tokens
        };
      } else if (status === 'failed' || status === 'stopped') {
        throw new Error(`Workflow ${status}: ${response.data.error || 'Unknown error'}`);
      }
      
      // Status is 'running', wait and retry
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      console.error('Error checking workflow status:', error.response?.data || error.message);
      throw error;
    }
  }
  
  throw new Error('Workflow timeout - exceeded maximum attempts');
}

// Function to format the report
function formatReport(workflowOutput) {
  // Extract the actual output from the workflow response
  const output = workflowOutput.outputs || workflowOutput;
  
  const date = new Date().toLocaleDateString('tr-TR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  
  // Check if output has a specific structure
  let reportContent = '';
  if (typeof output === 'object' && output !== null) {
    // If output has specific fields, format them
    if (output.text) {
      reportContent = output.text;
    } else if (output.report) {
      reportContent = output.report;
    } else if (output.content) {
      reportContent = output.content;
    } else {
      // Convert object to formatted HTML
      reportContent = '<pre>' + JSON.stringify(output, null, 2) + '</pre>';
    }
  } else if (typeof output === 'string') {
    reportContent = output;
  } else {
    reportContent = String(output);
  }
  
  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
        }
        .header {
          background-color: #f4f4f4;
          padding: 20px;
          border-radius: 5px;
          margin-bottom: 20px;
        }
        .content {
          background-color: #ffffff;
          padding: 20px;
          border: 1px solid #ddd;
          border-radius: 5px;
        }
        h1 {
          color: #2c3e50;
        }
        h2 {
          color: #34495e;
          border-bottom: 2px solid #ecf0f1;
          padding-bottom: 10px;
        }
        pre {
          background-color: #f5f5f5;
          padding: 10px;
          border-radius: 3px;
          overflow-x: auto;
        }
        .footer {
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid #eee;
          font-size: 12px;
          color: #777;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Günlük Rapor - ${date}</h1>
      </div>
      <div class="content">
        ${reportContent}
      </div>
      <div class="footer">
        <p>Bu rapor otomatik olarak oluşturulmuştur.</p>
        <p>© ${new Date().getFullYear()} ${process.env.COMPANY_NAME || 'Şirketiniz'}</p>
      </div>
    </body>
    </html>
  `;
  
  return htmlContent;
}

// Function to send email
async function sendEmail(reportContent) {
  try {
    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'Daily Report System'}" <${process.env.EMAIL_USER}>`,
      to: emailList,
      subject: `Günlük Rapor - ${new Date().toLocaleDateString('tr-TR')}`,
      html: reportContent
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending email:', error.message);
    throw error;
  }
}

// Main function to run the daily report
async function runDailyReport() {
  console.log(`[${new Date().toISOString()}] Starting daily report generation...`);
  
  try {
    // Step 1: Trigger Dify workflow
    const workflowResult = await triggerDifyWorkflow();
    console.log('Workflow triggered successfully');
    
    let finalOutput;
    
    // Step 2: Handle response based on mode
    if (workflowResult.status === 'succeeded' && workflowResult.outputs) {
      // Blocking mode - we already have the output
      finalOutput = workflowResult;
    } else if (workflowResult.workflow_run_id) {
      // Streaming mode or pending - wait for completion
      console.log('Workflow run ID:', workflowResult.workflow_run_id);
      finalOutput = await waitForWorkflowCompletion(workflowResult.workflow_run_id);
    } else {
      throw new Error('Invalid workflow response - no outputs or run ID');
    }
    
    console.log('Workflow completed successfully');
    
    // Step 3: Format the report
    const formattedReport = formatReport(finalOutput);
    
    // Step 4: Send email
    await sendEmail(formattedReport);
    
    console.log(`[${new Date().toISOString()}] Daily report completed successfully`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Daily report failed:`, error.message);
    
    // Send error notification
    try {
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .error { color: #d32f2f; }
          </style>
        </head>
        <body>
          <h2 class="error">Hata: Günlük Rapor Oluşturulamadı</h2>
          <p><strong>Tarih:</strong> ${new Date().toLocaleString('tr-TR')}</p>
          <p><strong>Hata Mesajı:</strong> ${error.message}</p>
          <p><strong>Detaylar:</strong> ${error.response?.data ? JSON.stringify(error.response.data) : 'N/A'}</p>
          <p>Lütfen sistem yöneticisi ile iletişime geçin.</p>
        </body>
        </html>
      `;
      await sendEmail(errorHtml);
    } catch (emailError) {
      console.error('Failed to send error notification:', emailError.message);
    }
  }
}

// Schedule cron job for 9 AM Turkey time
// Turkey time is UTC+3
cron.schedule('0 6 * * *', runDailyReport, {
  scheduled: true,
  timezone: "UTC"
});

// For Vercel deployment, we need to handle HTTP requests
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ 
    status: 'Running',
    nextRun: '9:00 AM Turkey Time',
    recipients: emailList.length
  });
});

// Manual trigger endpoint (optional, for testing)
app.post('/trigger', async (req, res) => {
  try {
    await runDailyReport();
    res.json({ status: 'Report sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Cron job scheduled for 9 AM Turkey time daily');
});

// For testing purposes
if (process.env.RUN_ON_START === 'true') {
  runDailyReport();
}