const socket = new SockJS('/ws');
const stompClient = Stomp.over(socket);

stompClient.connect({/*headers*/ },
    function onConnect(data) {
        console.log('STOMP is now connected!');

        // subscription
        stompClient.subscribe('/echo', (data) => {
            const ele = document.createElement('div');
            ele.textContent = data.body;
            document.body.appendChild(ele);
            ele.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        });

        // trigger some data
        let timer = 0;
        setInterval(() => {
            stompClient.send('/echo', {}, String(++timer));
        }, 6000);
    },
    (error) => console.error(error));
