// PayPal Integration
let paypalButtons = null;

async function initializePayPal() {
    try {
        // Get PayPal configuration
        const response = await fetch('/api/payment/paypal/config');
        const config = await response.json();
        
        if (!config.clientId) {
            console.error('PayPal client ID not found');
            return;
        }

        // Load PayPal SDK
        const script = document.createElement('script');
        script.src = `https://www.paypal.com/sdk/js?client-id=${config.clientId}&currency=USD`;
        script.async = true;
        script.onload = () => {
            renderPayPalButtons();
        };
        document.body.appendChild(script);
    } catch (error) {
        console.error('Failed to initialize PayPal:', error);
    }
}

function renderPayPalButtons() {
    if (paypalButtons) {
        paypalButtons.close();
    }

    paypalButtons = paypal.Buttons({
        style: {
            layout: 'vertical',
            color: 'blue',
            shape: 'rect',
            label: 'pay'
        },

        createOrder: async (data, actions) => {
            try {
                const response = await fetch('/api/payment/paypal/create-order', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        amount: document.getElementById('amount').value,
                        currency: 'USD'
                    })
                });
                const order = await response.json();
                return order.id;
            } catch (error) {
                console.error('Error creating PayPal order:', error);
                throw error;
            }
        },

        onApprove: async (data, actions) => {
            try {
                const response = await fetch('/api/payment/paypal/capture-payment', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        orderId: data.orderID
                    })
                });
                const result = await response.json();
                
                if (result.success) {
                    showSuccessMessage('Payment successful!');
                    // Update UI or redirect as needed
                } else {
                    showErrorMessage('Payment failed: ' + result.error);
                }
            } catch (error) {
                console.error('Error capturing PayPal payment:', error);
                showErrorMessage('Payment failed. Please try again.');
            }
        },

        onError: (err) => {
            console.error('PayPal error:', err);
            showErrorMessage('An error occurred with PayPal. Please try again.');
        },

        onCancel: () => {
            console.log('Payment cancelled by user');
        }
    });

    paypalButtons.render('#paypal-button-container');
}

function showSuccessMessage(message) {
    // Implement your success message UI
    alert(message);
}

function showErrorMessage(message) {
    // Implement your error message UI
    alert(message);
}

// Initialize PayPal when the page loads
document.addEventListener('DOMContentLoaded', initializePayPal); 